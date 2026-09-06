import type { AuthResult, Env } from "../types";

export const PROTOCOLS = ["chat", "messages", "responses"] as const;
export type Protocol = typeof PROTOCOLS[number];
export const PATHS: Record<Protocol, string> = {
  chat: "chat/completions", messages: "messages", responses: "responses"
};
export interface Provider {
  // HTTP base URL includes the version prefix, e.g. /v1.
  baseUrl?: string;
  gateway?: string;
  provider?: string;
  paths?: Partial<Record<Protocol, string>>;
  headers?: Record<string, string>;
  secretHeaders?: Record<string, { secret: string; prefix?: string }>;
}
export interface Target { provider: string; model: string }
export interface GatewayProfile {
  alias: string;
  namespace: string;
  keys: AuthResult["keyName"][];
  routes: Partial<Record<Protocol, Target[]>>;
  memory: "request" | "off";
  record: boolean;
  anthropicThinking: "passthrough" | "drop_block";
  maxMemoryChars?: number;
}
export interface GatewayConfig {
  version: 1;
  providers: Record<string, Provider>;
  profiles: GatewayProfile[];
}
export function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const text = (v: unknown): v is string => typeof v === "string" && !!v.trim();
const KEY_NAMES = ["CHATBOX_API_KEY", "IM_API_KEY", "DEBUG_API_KEY", "GUIDE_DOG_API_KEY"];

export function validateConfig(value: unknown): GatewayConfig {
  check(object(value) && value.version === 1, "Gateway config requires version: 1");
  check(object(value.providers), "providers must be an object");
  for (const [name, p] of Object.entries(value.providers)) {
    check(text(name) && name.length <= 128 && object(p), "Invalid provider");
    check(Boolean(p.baseUrl) !== Boolean(p.gateway), `${name}: choose baseUrl or gateway`);
    if (p.baseUrl) {
      const url = new URL(p.baseUrl);
      check(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash,
        `${name}: baseUrl must be HTTPS without credentials, query or fragment`);
    } else check(text(p.gateway) && text(p.provider), `${name}: gateway and provider are required`);
    if (p.paths !== undefined) {
      check(object(p.paths), `${name}: paths must be an object`);
      for (const [protocol, path] of Object.entries(p.paths)) {
        check(PROTOCOLS.includes(protocol as Protocol) && text(path) &&
          /^[a-zA-Z0-9_/-]+$/.test(path) && !path.startsWith("/"), `${name}: invalid protocol path`);
      }
    }
    for (const field of ["headers", "secretHeaders"] as const) {
      if (p[field] === undefined) continue;
      check(object(p[field]), `${name}: ${field} must be an object`);
      for (const [header, entry] of Object.entries(p[field])) {
        check(/^[a-zA-Z0-9-]+$/.test(header) && !["host", "content-length", "connection", "transfer-encoding"].includes(header.toLowerCase()), `${name}: invalid header`);
        if (field === "headers") {
          check(typeof entry === "string" && !/[\r\n]/.test(entry), `${name}: invalid header value`);
          check(!/authorization|api-key|token|cookie/i.test(header), `${name}: credentials belong in secretHeaders`);
        } else check(object(entry) && text(entry.secret) &&
          (entry.prefix === undefined || typeof entry.prefix === "string" && !/[\r\n]/.test(entry.prefix)), `${name}: invalid secret reference`);
      }
    }
  }
  check(Array.isArray(value.profiles), "profiles must be an array");
  const aliases = new Set<string>();
  for (const p of value.profiles) {
    check(object(p) && text(p.alias) && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(p.alias) && text(p.namespace) && p.namespace.length <= 128,
      "Profile requires an ASCII model alias and namespace (max 128 characters)");
    check(!aliases.has(p.alias), `Duplicate alias: ${p.alias}`);
    aliases.add(p.alias);
    check(Array.isArray(p.keys) && p.keys.length && p.keys.every((k: unknown) => KEY_NAMES.includes(String(k))), `${p.alias}: invalid keys`);
    check(p.memory === "request" || p.memory === "off", `${p.alias}: memory must be request or off`);
    check(typeof p.record === "boolean", `${p.alias}: record must be boolean`);
    check(["passthrough", "drop_block"].includes(p.anthropicThinking), `${p.alias}: invalid anthropicThinking`);
    check(p.maxMemoryChars === undefined || Number.isInteger(p.maxMemoryChars) && p.maxMemoryChars >= 256 && p.maxMemoryChars <= 24000, `${p.alias}: maxMemoryChars must be 256–24000`);
    check(object(p.routes) && Object.keys(p.routes).length, `${p.alias}: routes required`);
    for (const [protocol, targets] of Object.entries(p.routes)) {
      check(PROTOCOLS.includes(protocol as Protocol) && Array.isArray(targets) && targets.length > 0 && targets.length <= 4, `${p.alias}: invalid routes`);
      for (const t of targets) check(object(t) && text(t.model) && text(t.provider) && Object.hasOwn(value.providers, t.provider), `${p.alias}: invalid target`);
    }
  }
  return value as unknown as GatewayConfig;
}

export async function loadConfig(env: Env): Promise<GatewayConfig> {
  const row = await env.DB.prepare("SELECT config_json FROM gateway_config WHERE id = 1").first<{ config_json: string }>();
  if (row) return validateConfig(JSON.parse(row.config_json));
  if (env.GATEWAY_CONFIG) return validateConfig(JSON.parse(env.GATEWAY_CONFIG));
  return { version: 1, providers: {}, profiles: [] };
}
export function allowedProfiles(config: GatewayConfig, auth: AuthResult): GatewayProfile[] {
  return config.profiles.filter(p => p.keys.includes(auth.keyName) && auth.profile.scopes.includes("chat:proxy"));
}
export function resolveSecret(env: Env, name: string): string {
  const secrets = env.GATEWAY_SECRETS ? JSON.parse(env.GATEWAY_SECRETS) : {};
  const value = Object.hasOwn(secrets, name) ? secrets[name] : (env as unknown as Record<string, unknown>)[name];
  if (!text(value)) throw new Error(`Missing gateway secret: ${name}`);
  return value;
}
