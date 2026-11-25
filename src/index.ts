import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import express, { type Request, type Response } from "express";
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/express";
import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
  toWebRequest,
} from "@modelcontextprotocol/node";
import {
  acceptedContent,
  createMcpHandler,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  isInitializeRequest,
  isLegacyRequest,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type CallToolResult,
  type ElicitRequestFormParams,
  type InputRequiredResult,
  type McpRequestContext,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import "dotenv/config";
import { mountBillRoutes, registerBillTools } from "./bills/index.js";

const PORT = Number(process.env.PORT ?? 5000);
const HOST = process.env.HOST ?? "0.0.0.0";
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${PORT}`
).replace(/\/$/, "");

/** Required static API key for MCP connect (`Authorization: Bearer …`). */
const MCP_API_KEY = (process.env.MCP_API_KEY ?? "").trim();
if (!MCP_API_KEY) {
  console.error(
    "MCP_API_KEY is required. Set it in .env (see .env.example). Clients must send Authorization: Bearer <MCP_API_KEY>."
  );
  process.exit(1);
}

const MCP_API_KEY_BUF = Buffer.from(MCP_API_KEY);

function apiKeysEqual(candidate: string): boolean {
  const provided = Buffer.from(candidate);
  if (provided.length !== MCP_API_KEY_BUF.length) {
    return false;
  }
  return timingSafeEqual(provided, MCP_API_KEY_BUF);
}

const mcpServerUrl = new URL(`${PUBLIC_BASE_URL}/mcp`);
const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpServerUrl);

const apiKeyVerifier: OAuthTokenVerifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!apiKeysEqual(token)) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid API key");
    }
    // Static API keys have no natural expiry; populate far-future exp so the
    // SDK bearer gate does not reject unset expiresAt.
    const expiresAt = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
    return {
      token,
      clientId: "mcp-api-key",
      scopes: ["mcp"],
      expiresAt,
      resource: mcpServerUrl,
      extra: { authType: "api_key" },
    };
  },
};

const requireMcpApiKey = requireBearerAuth({
  verifier: apiKeyVerifier,
  requiredScopes: ["mcp"],
  resourceMetadataUrl,
  expectedResource: mcpServerUrl,
});

const allowedHosts = new Set<string>([
  "localhost",
  "127.0.0.1",
  "[::1]",
  ...((process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)),
]);

try {
  allowedHosts.add(new URL(PUBLIC_BASE_URL).hostname);
} catch {
  // ignore invalid PUBLIC_BASE_URL; health check will still start
}

const stateCodec = createRequestStateCodec<{ flowId: string }>({
  key: randomBytes(32),
  ttlSeconds: 15 * 60,
});

/** Sensitive credentials collected via URL mode — never returned through MCP. */
const apiKeyStore = new Map<
  string,
  { apiKey: string; submittedAt: number }
>();

/** Legacy-era completion notifiers keyed by elicitation / flow id. */
const completionNotifiers = new Map<string, () => Promise<void>>();

/** Providers supported by ``link_account`` (demo OAuth connect pages). */
const LINK_ACCOUNT_PROVIDERS = {
  atlassian: {
    label: "Atlassian",
    blurb:
      "Authorize Jira and Confluence for this demo. In production this would be Atlassian’s OAuth authorize page.",
  },
  github: {
    label: "GitHub",
    blurb:
      "Authorize GitHub for this demo. In production this would be GitHub’s OAuth authorize page.",
  },
} as const;

type LinkAccountProvider = keyof typeof LINK_ACCOUNT_PROVIDERS;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

const waiters = new Map<
  string,
  { resolve: () => void; reject: (err: Error) => void }
>();

function notifyFlowComplete(flowId: string): void {
  const waiter = waiters.get(flowId);
  if (waiter) {
    waiters.delete(flowId);
    waiter.resolve();
  }
  const notify = completionNotifiers.get(flowId);
  if (notify) {
    completionNotifiers.delete(flowId);
    void notify().catch((err) =>
      console.error("[server] elicitation complete notify failed:", err)
    );
  }
}

function waitForApiKey(
  flowId: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<string> {
  const existing = apiKeyStore.get(flowId);
  if (existing) {
    return Promise.resolve(existing.apiKey);
  }

  return new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new Error("API key collection was cancelled"));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for API key submission"));
    }, timeoutMs);

    const waiter = {
      resolve: () => {
        cleanup();
        const stored = apiKeyStore.get(flowId);
        if (!stored) {
          reject(new Error("API key missing after submission"));
          return;
        }
        resolve(stored.apiKey);
      },
      reject: (err: Error) => {
        cleanup();
        reject(err);
      },
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (waiters.get(flowId) === waiter) {
        waiters.delete(flowId);
      }
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    waiters.set(flowId, waiter);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const REGISTRATION_SCHEMA: ElicitRequestFormParams["requestedSchema"] = {
  type: "object",
  properties: {
    username: {
      type: "string",
      title: "Username",
      minLength: 3,
      maxLength: 20,
      description: "3–20 character username",
    },
    email: {
      type: "string",
      title: "Email",
      format: "email",
      description: "Your email address",
    },
    plan: {
      type: "string",
      title: "Plan",
      enum: ["free", "pro", "team"],
      default: "free",
    },
  },
  required: ["username", "email"],
};

const CONTACT_SCHEMA: ElicitRequestFormParams["requestedSchema"] = {
  type: "object",
  properties: {
    name: {
      type: "string",
      title: "Full name",
      description: "Your full name",
    },
    email: {
      type: "string",
      title: "Email",
      format: "email",
      description: "Your email address",
    },
    age: {
      type: "number",
      title: "Age",
      minimum: 18,
      description: "Your age (18+)",
    },
  },
  required: ["name", "email"],
};

const PREFERENCES_SCHEMA: ElicitRequestFormParams["requestedSchema"] = {
  type: "object",
  properties: {
    theme: {
      type: "string",
      title: "Theme",
      description: "Preferred UI theme",
      oneOf: [
        { const: "light", title: "Light" },
        { const: "dark", title: "Dark" },
        { const: "system", title: "System" },
      ],
      default: "system",
    },
    notifications: {
      type: "boolean",
      title: "Email notifications",
      description: "Receive product updates by email",
      default: true,
    },
    interests: {
      type: "array",
      title: "Interests",
      description: "Pick up to two interests",
      minItems: 1,
      maxItems: 2,
      items: {
        type: "string",
        enum: ["mcp", "agents", "security", "devtools"],
      },
      default: ["mcp"],
    },
  },
  required: ["theme", "interests"],
};

const DEPARTMENTS = [
  "Engineering",
  "Product",
  "Design",
  "Sales",
  "Marketing",
  "Operations",
  "People / HR",
  "Finance",
] as const;
const EMPLOYMENT_TYPES = ["Full-time", "Part-time", "Contract", "Intern"] as const;
const EXPERIENCE_LEVELS = [
  "Entry (0-2 yrs)",
  "Mid (3-5 yrs)",
  "Senior (6-9 yrs)",
  "Lead / Principal (10+ yrs)",
] as const;

/** 7-field form for requesting headcount for a new position. */
const POSITION_DEMAND_SCHEMA: ElicitRequestFormParams["requestedSchema"] = {
  type: "object",
  properties: {
    jobTitle: {
      type: "string",
      title: "Job title",
      minLength: 3,
      maxLength: 80,
      description: "Title of the new position, e.g. Senior Backend Engineer",
    },
    department: {
      type: "string",
      title: "Department",
      description: "Department the position belongs to",
      enum: [...DEPARTMENTS],
    },
    employmentType: {
      type: "string",
      title: "Employment type",
      enum: [...EMPLOYMENT_TYPES],
      default: "Full-time",
    },
    experienceLevel: {
      type: "string",
      title: "Experience level",
      enum: [...EXPERIENCE_LEVELS],
      default: "Mid (3-5 yrs)",
    },
    openings: {
      type: "integer",
      title: "Number of openings",
      minimum: 1,
      maximum: 50,
      default: 1,
      description: "How many people to hire for this position",
    },
    location: {
      type: "string",
      title: "Location",
      minLength: 2,
      maxLength: 80,
      description: "Office city or 'Remote'",
    },
    justification: {
      type: "string",
      title: "Business justification",
      maxLength: 500,
      description: "Why is this position needed? (optional)",
    },
  },
  required: [
    "jobTitle",
    "department",
    "employmentType",
    "experienceLevel",
    "openings",
    "location",
  ],
};

// ---- Server-side validation ------------------------------------------------
// Clients render forms but don't reliably enforce min/max/format/enum, and the
// SDK passes accepted content through unvalidated, so every structured form is
// re-validated here and the user is re-prompted with the problems.

/** Treats "" / null from a cleared optional field as "not provided". */
const emptyToUndefined = (value: unknown) =>
  value === "" || value === null ? undefined : value;

const registrationValidator = z.object({
  username: z.string().trim().min(3).max(20),
  email: z.email(),
  plan: z.preprocess(
    emptyToUndefined,
    z.enum(["free", "pro", "team"]).optional()
  ),
});

const contactValidator = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email(),
  age: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(18).max(120).optional()
  ),
});

const preferencesValidator = z.object({
  theme: z.enum(["light", "dark", "system"]),
  notifications: z.boolean().optional(),
  interests: z
    .array(z.enum(["mcp", "agents", "security", "devtools"]))
    .min(1)
    .max(2),
});

const positionDemandValidator = z.object({
  jobTitle: z.string().trim().min(3).max(80),
  department: z.enum(DEPARTMENTS),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  experienceLevel: z.enum(EXPERIENCE_LEVELS),
  openings: z.coerce.number().int().min(1).max(50),
  location: z.string().trim().min(2).max(80),
  justification: z.preprocess(
    emptyToUndefined,
    z.string().trim().max(500).optional()
  ),
});
type PositionDemand = z.infer<typeof positionDemandValidator>;

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.length ? `${issue.path.join(".")}: ` : "";
      return `• ${field}${issue.message}`;
    })
    .join("\n");
}

const MAX_FORM_ATTEMPTS = 3;

type FormOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; result: CallToolResult | InputRequiredResult };

const textResult = (text: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Collects a form via elicitation and validates the answer server-side.
 * On invalid input the user is asked again with the problems listed
 * (legacy era: up to MAX_FORM_ATTEMPTS pushes; modern era: a fresh
 * `input_required` round trip).
 */
async function collectValidatedForm<T>(args: {
  era: McpRequestContext["era"];
  ctx: ServerContext;
  /** `inputRequests` key used on the 2026-07-28 path. */
  key: string;
  /** Prefix for decline/cancel messages, e.g. "Registration". */
  label: string;
  message: string;
  requestedSchema: ElicitRequestFormParams["requestedSchema"];
  validator: z.ZodType<T>;
}): Promise<FormOutcome<T>> {
  const { era, ctx, key, label, message, requestedSchema, validator } = args;
  const retryMessage = (issues: string) =>
    `${message}\n\nSome values were invalid — please correct them:\n${issues}`;

  if (era === "legacy") {
    let prompt = message;
    for (let attempt = 1; attempt <= MAX_FORM_ATTEMPTS; attempt++) {
      const result = await ctx.mcpReq.elicitInput({
        mode: "form",
        message: prompt,
        requestedSchema,
      });
      if (result.action !== "accept" || !result.content) {
        return { ok: false, result: textResult(`${label} ${result.action}`) };
      }
      const parsed = validator.safeParse(result.content);
      if (parsed.success) return { ok: true, data: parsed.data };
      prompt = retryMessage(describeIssues(parsed.error));
    }
    return {
      ok: false,
      result: textResult(
        `${label} failed: input was still invalid after ${MAX_FORM_ATTEMPTS} attempts.`,
        true
      ),
    };
  }

  const ask = (prompt: string) =>
    inputRequired({
      inputRequests: {
        [key]: inputRequired.elicit({ message: prompt, requestedSchema }),
      },
    });

  const view = inputResponse(ctx.mcpReq.inputResponses, key);
  if (view.kind === "missing") return { ok: false, result: ask(message) };
  if (view.kind === "elicit" && view.action !== "accept") {
    return { ok: false, result: textResult(`${label} ${view.action}`) };
  }
  const parsed = validator.safeParse(
    acceptedContent(ctx.mcpReq.inputResponses, key)
  );
  if (!parsed.success) {
    return { ok: false, result: ask(retryMessage(describeIssues(parsed.error))) };
  }
  return { ok: true, data: parsed.data };
}

/** In-memory demo store of submitted position demands. */
const positionDemands = new Map<
  string,
  PositionDemand & { demandId: string; createdAt: string }
>();

function saveDemand(demand: PositionDemand): CallToolResult {
  const demandId = `DEM-${randomUUID().slice(0, 8).toUpperCase()}`;
  positionDemands.set(demandId, {
    ...demand,
    demandId,
    createdAt: new Date().toISOString(),
  });
  const lines = [
    `Demand ${demandId} created`,
    `Position: ${demand.jobTitle} (${demand.department})`,
    `Type: ${demand.employmentType} | Level: ${demand.experienceLevel}`,
    `Openings: ${demand.openings} | Location: ${demand.location}`,
    `Justification: ${demand.justification?.trim() || "—"}`,
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
function publicUrl(path: string): string {
  return `${PUBLIC_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

function buildServer(reqCtx: McpRequestContext): McpServer {
  const server = new McpServer(
    { name: "elicitation-server", version: "2.0.0" },
    { requestState: { verify: stateCodec.verify } }
  );

  // Optional demo tool. Studio header-connect probes with tools/list, not ping.
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Returns pong. Not required for Prism catalog connect.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (): Promise<CallToolResult> => ({
      content: [{ type: "text", text: "pong" }],
    })
  );

  // ---- Form mode: simple greeting ------------------------------------------
  server.registerTool(
    "greeting",
    {
      title: "Greeting (form elicitation)",
      description:
        "Form-mode elicitation demo: asks for a name via elicitation/create (mode form).",
    },
    async (ctx): Promise<CallToolResult | InputRequiredResult> => {
      const nameSchema = z.object({
        name: z.string().meta({ title: "Your name" }),
      });

      if (reqCtx.era === "legacy") {
        const result = await ctx.mcpReq.elicitInput({
          mode: "form",
          message: "Please enter your name",
          requestedSchema: {
            type: "object",
            properties: {
              name: { type: "string", title: "Your name" },
            },
            required: ["name"],
          },
        });
        if (result.action !== "accept" || !result.content) {
          return {
            content: [
              { type: "text", text: `Greeting ${result.action} — hello Stranger` },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Hello ${String(result.content.name ?? "Stranger")} (form mode)`,
            },
          ],
        };
      }

      const accepted = acceptedContent(
        ctx.mcpReq.inputResponses,
        "name",
        nameSchema
      );
      if (!accepted) {
        const view = inputResponse(ctx.mcpReq.inputResponses, "name");
        if (view.kind === "elicit" && view.action !== "accept") {
          return {
            content: [
              {
                type: "text",
                text: `Greeting ${view.action} — hello Stranger`,
              },
            ],
          };
        }
        return inputRequired({
          inputRequests: {
            name: inputRequired.elicit({
              message: "Please enter your name",
              requestedSchema: nameSchema,
            }),
          },
        });
      }
      return {
        content: [
          {
            type: "text",
            text: `Hello ${accepted.name} (form mode / 2026-07-28 input_required)`,
          },
        ],
      };
    }
  );

  // ---- Form mode: structured registration ----------------------------------
  server.registerTool(
    "register_user",
    {
      title: "Register user (form elicitation)",
      description:
        "Form-mode elicitation with string/email/enum fields per the MCP elicitation schema subset.",
    },
    async (ctx): Promise<CallToolResult | InputRequiredResult> => {
      const form = await collectValidatedForm({
        era: reqCtx.era,
        ctx,
        key: "form",
        label: "Registration",
        message: "Please provide your registration information",
        requestedSchema: REGISTRATION_SCHEMA,
        validator: registrationValidator,
      });
      if (!form.ok) return form.result;

      const { username, email, plan } = form.data;
      return textResult(
        `Registered ${username} <${email}> (plan: ${plan ?? "free"})`
      );
    }
  );

  // ---- Form mode: contact info ---------------------------------------------
  server.registerTool(
    "contact_info",
    {
      title: "Contact info (form elicitation)",
      description:
        "Form-mode elicitation collecting name, email, and optional age (matches the spec structured example).",
    },
    async (ctx): Promise<CallToolResult | InputRequiredResult> => {
      const form = await collectValidatedForm({
        era: reqCtx.era,
        ctx,
        key: "contact",
        label: "Contact collection",
        message: "Please provide your contact information",
        requestedSchema: CONTACT_SCHEMA,
        validator: contactValidator,
      });
      if (!form.ok) return form.result;

      const { name, email, age } = form.data;
      const agePart = age != null ? `, age ${age}` : "";
      return textResult(`Contact received: ${name} (${email}${agePart})`);
    }
  );

  // ---- Form mode: enums / multi-select / booleans --------------------------
  server.registerTool(
    "update_preferences",
    {
      title: "Update preferences (form elicitation)",
      description:
        "Form-mode elicitation covering titled enums, booleans, and multi-select arrays from the elicitation schema subset.",
    },
    async (ctx): Promise<CallToolResult | InputRequiredResult> => {
      const form = await collectValidatedForm({
        era: reqCtx.era,
        ctx,
        key: "prefs",
        label: "Preferences",
        message: "Update your preferences",
        requestedSchema: PREFERENCES_SCHEMA,
        validator: preferencesValidator,
      });
      if (!form.ok) return form.result;

      const prefs = form.data;
      return textResult(
        `Preferences saved: theme=${prefs.theme}, notifications=${Boolean(prefs.notifications)}, interests=${prefs.interests.join(",")}`
      );
    }
  );

  // ---- Form mode: job opening for a new position (7 form fields) ------------
  // Keep the description free of field names: agents treat listed fields as
  // prerequisites and ask for them in chat instead of calling the tool.
  server.registerTool(
    "create_job_opening",
    {
      title: "Create job opening (form elicitation)",
      description:
        "Creates a job opening for a new position at the company. This tool takes NO arguments: call it immediately and it opens an interactive form that collects all the details from the user. Do not ask the user for any information in chat first, and do not wait for details before calling it.",
    },
    async (ctx): Promise<CallToolResult | InputRequiredResult> => {
      const form = await collectValidatedForm({
        era: reqCtx.era,
        ctx,
        key: "demand",
        label: "Job opening",
        message: "Please fill in the details for the new job opening",
        requestedSchema: POSITION_DEMAND_SCHEMA,
        validator: positionDemandValidator,
      });
      if (!form.ok) return form.result;

      return saveDemand(form.data);
    }
  );

  // ---- URL mode: collect sensitive API key out-of-band ---------------------
  server.registerTool(
    "collect_api_key",
    {
      title: "Collect API key (URL elicitation)",
      description:
        "URL-mode elicitation for sensitive credentials. Opens a hosted page so the API key never passes through the MCP client (per MCP security rules).",
    },
    async (ctx): Promise<CallToolResult | InputRequiredResult> => {
      const existingState = ctx.mcpReq.requestState<{ flowId: string }>();
      const flowId = existingState?.flowId ?? randomUUID();
      const collectUrl = publicUrl(`/ui/set_api_key?flow=${encodeURIComponent(flowId)}`);

      if (reqCtx.era === "legacy") {
        const elicitationId = flowId;
        const notifyComplete = server.server.createElicitationCompletionNotifier(
          elicitationId,
          { relatedRequestId: ctx.mcpReq.id }
        );
        completionNotifiers.set(elicitationId, notifyComplete);

        try {
          const result = await ctx.mcpReq.elicitInput(
            {
              mode: "url",
              message:
                "Please provide your API key on the secure page. Credentials must not pass through the MCP client.",
              url: collectUrl,
              elicitationId,
            },
            { timeout: 10 * 60_000, signal: ctx.mcpReq.signal }
          );

          if (result.action !== "accept") {
            return {
              content: [
                {
                  type: "text",
                  text: `API key collection ${result.action}`,
                },
              ],
            };
          }

          const apiKey = await waitForApiKey(
            flowId,
            10 * 60_000,
            ctx.mcpReq.signal
          );
          const suffix = apiKey.slice(-4);
          apiKeyStore.delete(flowId);
          return {
            content: [
              {
                type: "text",
                text: `API key stored server-side (ends with …${suffix}). The secret never traversed the MCP client.`,
              },
            ],
          };
        } finally {
          completionNotifiers.delete(elicitationId);
        }
      }

      // 2026-07-28: URL elicitation via input_required / requestState
      const already = apiKeyStore.get(flowId);
      if (already) {
        const suffix = already.apiKey.slice(-4);
        apiKeyStore.delete(flowId);
        return {
          content: [
            {
              type: "text",
              text: `API key stored server-side (ends with …${suffix}). The secret never traversed the MCP client.`,
            },
          ],
        };
      }

      const auth = inputResponse(ctx.mcpReq.inputResponses, "auth");
      if (auth.kind === "elicit" && auth.action !== "accept") {
        return {
          content: [
            { type: "text", text: `API key collection ${auth.action}` },
          ],
        };
      }

      if (auth.kind === "missing") {
        return inputRequired({
          requestState: await stateCodec.mint({ flowId }),
          inputRequests: {
            auth: inputRequired.elicitUrl({
              message:
                "Please provide your API key on the secure page. Credentials must not pass through the MCP client.",
              url: collectUrl,
            }),
          },
        });
      }

      // Continue/accept without a saved key — re-prompt instead of blocking the
      // catalog HTTP call for minutes (gateway/proxy timeouts make that look broken).
      const submitted = apiKeyStore.get(flowId);
      if (!submitted) {
        return inputRequired({
          requestState: await stateCodec.mint({ flowId }),
          inputRequests: {
            auth: inputRequired.elicitUrl({
              message:
                "API key not received yet. Finish the secure page, then choose Continue again.",
              url: collectUrl,
            }),
          },
        });
      }
      const suffix = submitted.apiKey.slice(-4);
      apiKeyStore.delete(flowId);
      return {
        content: [
          {
            type: "text",
            text: `API key stored server-side (ends with …${suffix}). The secret never traversed the MCP client.`,
          },
        ],
      };
    }
  );

  // ---- URL mode: simulated third-party OAuth connect -----------------------
  server.registerTool(
    "link_account",
    {
      title: "Link account (URL elicitation)",
      description:
        "URL-mode elicitation that opens a hosted connect page for Atlassian or GitHub (simulates third-party OAuth).",
      inputSchema: z.object({
        provider: z
          .enum(["atlassian", "github"])
          .meta({
            description: "Which account to link: Atlassian (Jira/Confluence) or GitHub",
            title: "Provider",
          }),
      }),
    },
    async (
      { provider },
      ctx
    ): Promise<CallToolResult | InputRequiredResult> => {
      const meta = LINK_ACCOUNT_PROVIDERS[provider];
      const connectUrl = publicUrl(
        `/ui/connect?provider=${encodeURIComponent(provider)}`
      );

      if (reqCtx.era === "legacy") {
        const elicitationId = randomUUID();
        const notifyComplete = server.server.createElicitationCompletionNotifier(
          elicitationId,
          { relatedRequestId: ctx.mcpReq.id }
        );
        // Demo: auto-complete shortly after consent UI would open.
        // Real OAuth would complete from the redirect callback instead.
        setTimeout(() => {
          void notifyComplete().catch((err) =>
            console.error("[server] link_account complete failed:", err)
          );
        }, 1500);

        const result = await ctx.mcpReq.elicitInput(
          {
            mode: "url",
            message: `Sign in to ${meta.label} to link your account`,
            url: connectUrl,
            elicitationId,
          },
          { timeout: 10 * 60_000, signal: ctx.mcpReq.signal }
        );

        return {
          content: [
            {
              type: "text",
              text:
                result.action === "accept"
                  ? `Linked ${meta.label} via URL-mode elicitation`
                  : `Link ${meta.label} ${result.action}`,
            },
          ],
        };
      }

      const auth = inputResponse(ctx.mcpReq.inputResponses, "auth");
      if (auth.kind === "missing") {
        return inputRequired({
          inputRequests: {
            auth: inputRequired.elicitUrl({
              message: `Sign in to ${meta.label} to link your account`,
              url: connectUrl,
            }),
          },
        });
      }
      if (auth.kind === "elicit" && auth.action !== "accept") {
        return {
          content: [
            { type: "text", text: `Link ${meta.label} ${auth.action}` },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Linked ${meta.label} via URL-mode elicitation (2026-07-28)`,
          },
        ],
      };
    }
  );

  // ---- Bills / payments (URL elicitation checkout) -------------------------
  registerBillTools(server, reqCtx, {
    publicUrl,
    mintState: (data) => stateCodec.mint(data),
    stashCompletionNotifier: (id, notify) => {
      completionNotifiers.set(id, notify);
    },
  });

  return server;
}

// --- HTTP surface -----------------------------------------------------------

const app = createMcpExpressApp({
  host: HOST,
  allowedHosts: [...allowedHosts],
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    publicBaseUrl: PUBLIC_BASE_URL,
    allowedHosts: [...allowedHosts],
    auth: {
      type: "api_key",
      header: "Authorization",
      scheme: "Bearer",
      required: true,
    },
  });
});

app.get("/ui/set_api_key", (req: Request, res: Response) => {
  const flow = String(req.query.flow ?? "");
  if (!flow) {
    res.status(400).send("Missing flow id");
    return;
  }

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Set API Key</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: #e2e8f0; }
    main { width: min(420px, 92vw); background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 28px; }
    h1 { margin: 0 0 8px; font-size: 1.35rem; }
    p { margin: 0 0 20px; color: #94a3b8; line-height: 1.45; font-size: 0.95rem; }
    label { display: block; font-size: 0.85rem; margin-bottom: 6px; color: #cbd5e1; }
    input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: inherit; }
    button { margin-top: 16px; width: 100%; padding: 11px 14px; border: 0; border-radius: 8px; background: #38bdf8; color: #0f172a; font-weight: 600; cursor: pointer; }
    .ok { color: #86efac; }
  </style>
</head>
<body>
  <main>
    <h1>Provide API key</h1>
    <p>This page is served by the MCP server over URL-mode elicitation. Your key is posted directly here and never flows through the MCP client or model context.</p>
    <form method="post" action="/ui/set_api_key">
      <input type="hidden" name="flow" value="${flow.replace(/"/g, "&quot;")}" />
      <label for="apiKey">API key</label>
      <input id="apiKey" name="apiKey" type="password" autocomplete="off" required minlength="4" placeholder="sk-…" />
      <button type="submit">Save securely</button>
    </form>
  </main>
</body>
</html>`);
});

app.post(
  "/ui/set_api_key",
  express.urlencoded({ extended: false }),
  (req: Request, res: Response) => {
    const flow = String(req.body?.flow ?? "");
    const apiKey = String(req.body?.apiKey ?? "");
    if (!flow || apiKey.length < 4) {
      res.status(400).send("Invalid submission");
      return;
    }

    apiKeyStore.set(flow, { apiKey, submittedAt: Date.now() });
    notifyFlowComplete(flow);

    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>API key saved</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: #e2e8f0; font-family: ui-sans-serif, system-ui, sans-serif; }
    main { width: min(420px, 92vw); background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 28px; }
    h1 { margin: 0 0 8px; font-size: 1.35rem; color: #86efac; }
    p { margin: 0; color: #94a3b8; line-height: 1.45; }
  </style>
</head>
<body>
  <main>
    <h1>Saved</h1>
    <p>Your API key was stored on the server. You can close this tab and return to the MCP client.</p>
  </main>
</body>
</html>`);
  }
);

app.get("/ui/connect", (req: Request, res: Response) => {
  const raw = String(req.query.provider ?? "");
  const provider = (
    raw in LINK_ACCOUNT_PROVIDERS ? raw : ""
  ) as LinkAccountProvider | "";
  const meta = provider
    ? LINK_ACCOUNT_PROVIDERS[provider]
    : {
        label: "Unknown provider",
        blurb:
          "Pick Atlassian or GitHub when calling link_account. This page only demos those two connect flows.",
      };
  const title = escapeHtml(meta.label);
  const blurb = escapeHtml(meta.blurb);
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect ${title}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111827; color: #e5e7eb; font-family: ui-sans-serif, system-ui, sans-serif; }
    main { width: min(440px, 92vw); background: #1f2937; border: 1px solid #374151; border-radius: 12px; padding: 28px; }
    h1 { margin: 0 0 8px; font-size: 1.35rem; }
    p { margin: 0 0 12px; color: #9ca3af; line-height: 1.45; }
    .pill { display: inline-block; margin-bottom: 12px; padding: 2px 10px; border-radius: 999px; font-size: 0.75rem; background: #374151; color: #e5e7eb; }
  </style>
</head>
<body>
  <main>
    <span class="pill">${provider ? escapeHtml(provider) : "unsupported"}</span>
    <h1>Connect ${title}</h1>
    <p>${blurb}</p>
    <p>This page is reached via URL-mode elicitation. You can close this tab and choose Continue in the MCP client.</p>
  </main>
</body>
</html>`);
});

mountBillRoutes(app, { onPaymentPosted: notifyFlowComplete });

// Modern (2026-07-28) per-request handler — rejects legacy so the sessionful arm owns it.
const modern = toNodeHandler(
  createMcpHandler(buildServer, { legacy: "reject" })
);

type Session = {
  transport: NodeStreamableHTTPServerTransport;
  open: number;
  lastActive: number;
};
const sessions = new Map<string, Session>();
const IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 100;

async function handleLegacy(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown
): Promise<void> {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  const session = sid ? sessions.get(sid) : undefined;

  if (session) {
    if (res.socket && !res.destroyed) {
      session.open++;
      res.on("close", () => {
        session.open--;
        session.lastActive = Date.now();
      });
    }
    await session.transport.handleRequest(req, res, body);
    return;
  }

  if (!sid && isInitializeRequest(body)) {
    if (sessions.size >= MAX_SESSIONS) {
      res
        .writeHead(503, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Too many open sessions" },
            id: null,
          })
        );
      return;
    }

    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, {
          transport,
          open: 0,
          lastActive: Date.now(),
        });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    await buildServer({ era: "legacy" }).connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  res
    .writeHead(sid ? 404 : 400, { "content-type": "application/json" })
    .end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: sid
          ? { code: -32001, message: "Session not found" }
          : { code: -32000, message: "Bad Request: Session ID required" },
        id: null,
      })
    );
}

setInterval(() => {
  const cutoff = Date.now() - IDLE_MS;
  for (const session of sessions.values()) {
    if (session.open === 0 && session.lastActive < cutoff) {
      void session.transport.close().catch(console.error);
    }
  }
}, 60_000).unref();

app.all("/mcp", requireMcpApiKey, (req: Request, res: Response) => {
  void (async () => {
    // Express json() already drained the Node stream — rebuild the Web Request
    // from req.body so server/discover (modern) is not misclassified as legacy.
    const parsedBody = req.method === "POST" ? req.body : undefined;
    const webRequest = await toWebRequest(req, parsedBody);
    const legacy = await isLegacyRequest(webRequest, parsedBody);

    if (legacy) {
      await handleLegacy(req, res, parsedBody);
    } else {
      await modern(req, res, parsedBody);
    }
  })().catch((error) => {
    console.error(
      "[server] /mcp error:",
      error instanceof Error ? error.message : error
    );
    if (!res.headersSent) {
      res.status(500).end();
    }
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Elicitation MCP server listening on http://${HOST}:${PORT}`);
  console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
  console.log(`MCP endpoint: ${publicUrl("/mcp")}`);
  console.log(`Allowed hosts: ${[...allowedHosts].join(", ")}`);
  console.log(
    "MCP auth: Authorization Bearer required (MCP_API_KEY); wrong/missing key → 401"
  );
});
