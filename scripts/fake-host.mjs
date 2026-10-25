/**
 * A minimal stand-in for the DSH services this plugin touches, written against the
 * interfaces in deepseek-ai/deepseek-harness (system-prompt PromptSection, tools
 * ToolDefinition, session/event, agent/created|disposed). It is NOT DeepSeek Harness:
 * passing here does not prove the plugin loads in a real DSH install.
 */

// The JSON Schema subset the DSH tool registry accepts (packages/core/tools/src/json-schema.ts).
const CONSTRAINTS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples']);

export function checkSchema(node, path = 'schema') {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new TypeError(`${path} must be an object`);
  for (const key of Object.keys(node)) {
    if (!CONSTRAINTS.has(key) && !ANNOTATIONS.has(key)) throw new TypeError(`${path}.${key} is not a supported keyword`);
  }
  for (const [key, child] of Object.entries(node.properties || {})) checkSchema(child, `${path}.properties.${key}`);
  if (node.items) checkSchema(node.items, `${path}.items`);
}

const typeOf = value => (value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value);

export function validateValue(schema, value, path = 'value') {
  const actual = typeOf(value);
  if (schema.type && schema.type !== actual && !(schema.type === 'number' && actual === 'integer')) throw new TypeError(`${path} must be ${schema.type}, got ${actual}`);
  if (schema.enum && !schema.enum.includes(value)) throw new TypeError(`${path} is not an allowed value`);
  if (actual === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required`);
    for (const [key, child] of Object.entries(value)) {
      const spec = schema.properties?.[key];
      if (spec) validateValue(spec, child, `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new TypeError(`${path}.${key} is not allowed`);
    }
  }
  if (actual === 'array' && schema.items) value.forEach((item, i) => validateValue(schema.items, item, `${path}[${i}]`));
}

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

export function createHost() {
  const listeners = new Map();
  const disposers = [];
  const tools = new Map();
  const agents = new Map();
  const logs = [];
  const on = (name, listener) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(listener);
    return () => listeners.set(name, listeners.get(name).filter(l => l !== listener));
  };
  const emit = (name, ...args) => { for (const listener of listeners.get(name) || []) listener(...args); };

  const ctx = {
    logger: { info: message => logs.push(['info', message]), warn: message => logs.push(['warn', message]) },
    on(name, listener) { const off = on(name, listener); disposers.push(off); return off; },
    effect(setup) { const dispose = setup(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
    agents: { list: () => [...agents.values()] },
    tools: {
      register(definition) {
        if (typeof definition?.name !== 'string' || !definition.name) throw new TypeError('tool needs a name');
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
        if (typeof definition.execute !== 'function' || typeof definition.output?.render !== 'function') throw new TypeError(`tool "${definition.name}" must declare execute and output { schema, render }`);
        checkSchema(definition.parameters, `${definition.name}.parameters`);
        checkSchema(definition.output.schema, `${definition.name}.output.schema`);
        tools.set(definition.name, definition);
        const dispose = () => tools.delete(definition.name);
        disposers.push(dispose);
        return dispose;
      },
    },
  };

  function createAgent(id) {
    const sections = new Map();
    const agent = {
      id,
      sections,
      ctx: {
        inject(deps, callback) {
          if (deps.join() !== 'systemPrompt') throw new Error(`fake agent only provides systemPrompt, asked for ${deps}`);
          const owned = [];
          callback({
            systemPrompt: {
              section(section) {
                if (!Number.isFinite(section.order)) throw new TypeError('order must be finite');
                if (sections.has(section.name)) throw new Error(`duplicate prompt section ${section.name}`);
                sections.set(section.name, section);
                owned.push(section.name);
                return () => sections.delete(section.name);
              },
            },
          });
          return { dispose() { for (const name of owned) sections.delete(name); } };
        },
      },
    };
    agents.set(id, agent);
    emit('agent/created', { agent, source: { kind: 'new' } });
    return agent;
  }

  return {
    ctx,
    tools,
    logs,
    createAgent,
    disposeAgent(agent) { agents.delete(agent.id); emit('agent/disposed', { agent }); },
    /** Emits a session `user/message`; `kind` other than "user" models injected context. */
    say(agent, text, kind = 'user') {
      const session = { id: agent.id, header: { id: agent.id } };
      emit('session/event', session, { type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } });
    },
    reply(agent, text) {
      const session = { id: agent.id, header: { id: agent.id } };
      emit('session/event', session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
    },
    /** Concatenates this agent's sections in ascending order, as system-prompt assembly does. */
    prompt(agent) {
      return [...agent.sections.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
        .map(section => (typeof section.text === 'function' ? section.text({}) : section.text)).filter(Boolean).join('\n\n');
    },
    /** Runs one tool call like the registry: frozen args, exec identity, schema-checked value, rendered text. */
    async call(agent, name, args = {}) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`no tool ${name}`);
      const frozen = deepFreeze(structuredClone(args));
      const exec = Object.freeze({ callId: `call-${Math.random().toString(36).slice(2)}`, name, arguments: frozen, agent, token: Symbol('exec'), signal: new AbortController().signal });
      const value = await tool.execute(frozen, exec);
      validateValue(tool.output.schema, structuredClone(value));
      return { value, text: tool.output.render(frozen, value).map(block => block.text).join('') };
    },
    /** Waits for a plugin log line, e.g. the one the plugin writes once its archive is loaded. */
    async waitForLog(pattern, timeoutMs = 2000) {
      const start = Date.now();
      while (!logs.some(([, message]) => pattern.test(message))) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for log ${pattern}`);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    },
    unload() { while (disposers.length) disposers.pop()(); },
  };
}
