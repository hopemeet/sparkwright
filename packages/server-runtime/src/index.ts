import {
  InMemorySessionStore,
  createId,
  createRun as createCoreRun,
  type AppendOnlySessionStore,
  type ApprovalRequest,
  type ApprovalResponse,
  type CreateRunOptions,
  type EventType,
  type InteractionChannel,
  type InteractionNotification,
  type InteractionQuestionRequest,
  type InteractionQuestionResponse,
  type ModelAdapter,
  type Policy,
  type RunHandle,
  type RunId,
  type RunResult,
  type Session,
  type SessionEventInput,
  type SessionRecord,
  type SessionStore,
  type SparkwrightEvent,
  type ToolDefinition,
} from "@sparkwright/core";

export type ServerRuntimeMessageType =
  | "runtime.ready"
  | "run.created"
  | "run.event"
  | "run.result"
  | "run.cancelled"
  | "session.created"
  | "session.updated"
  | "interaction.requested"
  | "interaction.resolved"
  | "capability.registered"
  | "capability.unregistered";

export interface ServerRuntimeMessage<TPayload = unknown> {
  id: string;
  type: ServerRuntimeMessageType;
  timestamp: string;
  payload: TPayload;
  metadata: Record<string, unknown>;
}

export interface ServerRuntimeSubscriptionFilter {
  types?: ServerRuntimeMessageType[];
  runIds?: string[];
  sessionIds?: string[];
  eventTypes?: EventType[];
}

export interface ServerRuntimeSubscription {
  id: string;
  /** @reserved Public subscription-control helper consumed by transports. */
  unsubscribe(): void;
}

export type ServerRuntimeSubscriber = (
  message: ServerRuntimeMessage,
) => void | Promise<void>;

export class DurableCommandDispatcher {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  dispatch<TResult>(
    commandId: string,
    consume: () => Promise<TResult>,
  ): Promise<TResult> {
    const existing = this.inFlight.get(commandId);
    if (existing) return existing as Promise<TResult>;
    const pending = consume().finally(() => {
      if (this.inFlight.get(commandId) === pending) {
        this.inFlight.delete(commandId);
      }
    });
    this.inFlight.set(commandId, pending);
    return pending;
  }

  isInFlight(commandId: string): boolean {
    return this.inFlight.has(commandId);
  }
}

export interface PublishMessageInput<TPayload = unknown> {
  type: ServerRuntimeMessageType;
  payload: TPayload;
  metadata?: Record<string, unknown>;
}

export class ConnectionHub {
  private readonly subscribers = new Map<
    string,
    {
      filter: ServerRuntimeSubscriptionFilter;
      subscriber: ServerRuntimeSubscriber;
    }
  >();
  private readonly history: ServerRuntimeMessage[] = [];
  private readonly runSubscriptions = new WeakMap<RunHandle, () => void>();

  constructor(private readonly options: { historyLimit?: number } = {}) {}

  subscribe(
    filter: ServerRuntimeSubscriptionFilter,
    subscriber: ServerRuntimeSubscriber,
  ): ServerRuntimeSubscription {
    const id = createId("sub");
    this.subscribers.set(id, {
      filter: normalizeFilter(filter),
      subscriber,
    });

    return {
      id,
      unsubscribe: () => {
        this.subscribers.delete(id);
      },
    };
  }

  publish<TPayload>(
    input: PublishMessageInput<TPayload>,
  ): ServerRuntimeMessage<TPayload> {
    const message: ServerRuntimeMessage<TPayload> = {
      id: createId("srvmsg"),
      type: input.type,
      timestamp: new Date().toISOString(),
      payload: input.payload,
      metadata: input.metadata ? { ...input.metadata } : {},
    };

    this.record(message);
    for (const entry of this.subscribers.values()) {
      if (!matchesFilter(entry.filter, message)) continue;
      void Promise.resolve(entry.subscriber(message)).catch((err) => {
        console.warn(
          `[sparkwright/server-runtime] subscriber failed: ${errorMessage(err)}`,
        );
      });
    }
    return message;
  }

  attachRun(run: RunHandle, metadata: Record<string, unknown> = {}): void {
    if (this.runSubscriptions.has(run)) return;
    for (const event of run.events.all()) {
      this.publishRunEvent(event, metadata);
    }
    const unsubscribe = run.events.subscribe((event) => {
      this.publishRunEvent(event, metadata);
    });
    this.runSubscriptions.set(run, unsubscribe);
  }

  detachRun(run: RunHandle): void {
    const unsubscribe = this.runSubscriptions.get(run);
    if (!unsubscribe) return;
    unsubscribe();
    this.runSubscriptions.delete(run);
  }

  replay(filter: ServerRuntimeSubscriptionFilter = {}): ServerRuntimeMessage[] {
    const normalized = normalizeFilter(filter);
    return this.history.filter((message) => matchesFilter(normalized, message));
  }

  private publishRunEvent(
    event: SparkwrightEvent,
    metadata: Record<string, unknown>,
  ): void {
    this.publish({
      type: "run.event",
      payload: event,
      metadata: {
        ...metadata,
        runId: event.runId,
        eventType: event.type,
      },
    });
  }

  private record(message: ServerRuntimeMessage): void {
    const limit = this.options.historyLimit ?? 500;
    if (limit <= 0) return;
    this.history.push(message);
    if (this.history.length > limit) {
      this.history.splice(0, this.history.length - limit);
    }
  }
}

export interface PendingInteraction<TRequest = unknown> {
  id: string;
  kind: "approval" | "question";
  runId: RunId;
  request: TRequest;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface ResolveApprovalInput {
  approvalId: string;
  decision: ApprovalResponse["decision"];
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface ResolveQuestionInput {
  questionId: string;
  value: string;
  metadata?: Record<string, unknown>;
}

export interface ApprovalBrokerOptions {
  hub?: ConnectionHub;
  defaultApprovalTimeoutMs?: number;
}

export class ApprovalBroker {
  private readonly hub?: ConnectionHub;
  private readonly defaultApprovalTimeoutMs?: number;
  private readonly pendingApprovals = new Map<
    string,
    {
      request: ApprovalRequest;
      resolve: (response: ApprovalResponse) => void;
      timeout?: ReturnType<typeof setTimeout>;
      metadata: Record<string, unknown>;
    }
  >();
  private readonly pendingQuestions = new Map<
    string,
    {
      request: InteractionQuestionRequest;
      resolve: (response: InteractionQuestionResponse) => void;
      timeout?: ReturnType<typeof setTimeout>;
      metadata: Record<string, unknown>;
    }
  >();

  constructor(options: ApprovalBrokerOptions = {}) {
    this.hub = options.hub;
    this.defaultApprovalTimeoutMs = options.defaultApprovalTimeoutMs;
  }

  createInteractionChannel(
    options: {
      approvalTimeoutMs?: number;
      questionTimeoutMs?: number;
      metadata?: Record<string, unknown>;
    } = {},
  ): InteractionChannel {
    return {
      approve: (request) =>
        this.requestApproval(request, {
          timeoutMs: options.approvalTimeoutMs,
          metadata: options.metadata,
        }),
      ask: (request) =>
        this.requestQuestion(request, {
          timeoutMs: options.questionTimeoutMs,
          metadata: options.metadata,
        }),
      notify: (notification) => this.notify(notification, options.metadata),
    };
  }

  requestApproval(
    request: ApprovalRequest,
    options: {
      timeoutMs?: number;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<ApprovalResponse> {
    if (this.pendingApprovals.has(request.id)) {
      throw new Error(`Approval already pending: ${request.id}`);
    }

    const metadata = options.metadata ? { ...options.metadata } : {};
    const timeoutMs = options.timeoutMs ?? this.defaultApprovalTimeoutMs;
    return new Promise<ApprovalResponse>((resolve) => {
      const timeout = this.createTimeout(timeoutMs, () => {
        this.pendingApprovals.delete(request.id);
        const response: ApprovalResponse = {
          approvalId: request.id,
          decision: "denied",
          message: `Approval timed out after ${timeoutMs}ms.`,
        };
        this.publishResolved("approval", request.runId, response, metadata);
        resolve(response);
      });

      this.pendingApprovals.set(request.id, {
        request,
        resolve,
        timeout,
        metadata,
      });
      this.hub?.publish({
        type: "interaction.requested",
        payload: {
          kind: "approval",
          request,
        },
        metadata: {
          ...metadata,
          runId: request.runId,
          interactionId: request.id,
          interactionKind: "approval",
        },
      });
    });
  }

  resolveApproval(input: ResolveApprovalInput): boolean {
    const pending = this.pendingApprovals.get(input.approvalId);
    if (!pending) return false;
    this.pendingApprovals.delete(input.approvalId);
    if (pending.timeout) clearTimeout(pending.timeout);

    const response: ApprovalResponse = {
      approvalId: pending.request.id,
      decision: input.decision,
      message: input.message,
    };
    pending.resolve(response);
    this.publishResolved("approval", pending.request.runId, response, {
      ...pending.metadata,
      ...(input.metadata ?? {}),
    });
    return true;
  }

  requestQuestion(
    request: InteractionQuestionRequest,
    options: {
      timeoutMs?: number;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<InteractionQuestionResponse> {
    if (this.pendingQuestions.has(request.id)) {
      throw new Error(`Question already pending: ${request.id}`);
    }

    const metadata = options.metadata ? { ...options.metadata } : {};
    return new Promise<InteractionQuestionResponse>((resolve) => {
      const timeout = this.createTimeout(options.timeoutMs, () => {
        this.pendingQuestions.delete(request.id);
        const response: InteractionQuestionResponse = {
          id: request.id,
          value: request.defaultChoiceId ?? "",
          metadata: {
            timedOut: true,
          },
        };
        this.publishResolved("question", request.runId, response, metadata);
        resolve(response);
      });

      this.pendingQuestions.set(request.id, {
        request,
        resolve,
        timeout,
        metadata,
      });
      this.hub?.publish({
        type: "interaction.requested",
        payload: {
          kind: "question",
          request,
        },
        metadata: {
          ...metadata,
          runId: request.runId,
          interactionId: request.id,
          interactionKind: "question",
        },
      });
    });
  }

  resolveQuestion(input: ResolveQuestionInput): boolean {
    const pending = this.pendingQuestions.get(input.questionId);
    if (!pending) return false;
    this.pendingQuestions.delete(input.questionId);
    if (pending.timeout) clearTimeout(pending.timeout);

    const response: InteractionQuestionResponse = {
      id: pending.request.id,
      value: input.value,
      metadata: input.metadata,
    };
    pending.resolve(response);
    this.publishResolved("question", pending.request.runId, response, {
      ...pending.metadata,
      ...(input.metadata ?? {}),
    });
    return true;
  }

  notify(
    notification: InteractionNotification,
    metadata: Record<string, unknown> = {},
  ): void {
    this.hub?.publish({
      type: "interaction.requested",
      payload: {
        kind: "notification",
        notification,
      },
      metadata: {
        ...metadata,
        runId: notification.runId,
        interactionId: notification.id,
        interactionKind: "notification",
      },
    });
    this.hub?.publish({
      type: "interaction.resolved",
      payload: {
        kind: "notification",
        notification,
      },
      metadata: {
        ...metadata,
        runId: notification.runId,
        interactionId: notification.id,
        interactionKind: "notification",
      },
    });
  }

  pending(): Array<
    PendingInteraction<ApprovalRequest | InteractionQuestionRequest>
  > {
    const approvals = [...this.pendingApprovals.values()].map((entry) => ({
      id: entry.request.id,
      kind: "approval" as const,
      runId: entry.request.runId,
      request: entry.request,
      createdAt: entry.request.createdAt,
      metadata: { ...entry.metadata },
    }));
    const questions = [...this.pendingQuestions.values()].map((entry) => ({
      id: entry.request.id,
      kind: "question" as const,
      runId: entry.request.runId,
      request: entry.request,
      createdAt: new Date().toISOString(),
      metadata: { ...entry.metadata },
    }));
    return [...approvals, ...questions];
  }

  private createTimeout(
    timeoutMs: number | undefined,
    onTimeout: () => void,
  ): ReturnType<typeof setTimeout> | undefined {
    if (timeoutMs === undefined) return undefined;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("timeoutMs must be a positive integer.");
    }
    return setTimeout(onTimeout, timeoutMs);
  }

  private publishResolved(
    kind: "approval" | "question",
    runId: RunId,
    response: ApprovalResponse | InteractionQuestionResponse,
    metadata: Record<string, unknown>,
  ): void {
    const interactionId =
      kind === "approval"
        ? (response as ApprovalResponse).approvalId
        : (response as InteractionQuestionResponse).id;
    this.hub?.publish({
      type: "interaction.resolved",
      payload: {
        kind,
        response,
      },
      metadata: {
        ...metadata,
        runId,
        interactionId,
        interactionKind: kind,
      },
    });
  }
}

export type ServerCapabilityKind =
  | "model"
  | "tool"
  | "policy"
  | "workspace"
  | "context"
  | "interaction"
  | "custom";

export interface ServerCapabilityBinding<TValue = unknown> {
  id: string;
  kind: ServerCapabilityKind;
  name: string;
  description?: string;
  value: TValue;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterServerCapabilityInput<TValue = unknown> {
  id?: string;
  kind: ServerCapabilityKind;
  name: string;
  description?: string;
  value: TValue;
  metadata?: Record<string, unknown>;
}

export class ServerCapabilityRegistry {
  private readonly entries = new Map<string, ServerCapabilityBinding>();

  constructor(private readonly hub?: ConnectionHub) {}

  register<TValue>(
    input: RegisterServerCapabilityInput<TValue>,
  ): ServerCapabilityBinding<TValue> {
    const id = input.id ?? `${input.kind}:${input.name}`;
    const now = new Date().toISOString();
    const entry: ServerCapabilityBinding<TValue> = {
      id,
      kind: input.kind,
      name: input.name,
      description: input.description,
      value: input.value,
      metadata: input.metadata ? { ...input.metadata } : {},
      createdAt: this.entries.get(id)?.createdAt ?? now,
      updatedAt: now,
    };
    this.entries.set(id, entry as ServerCapabilityBinding);
    this.hub?.publish({
      type: "capability.registered",
      payload: describeServerCapability(entry),
      metadata: {
        capabilityId: entry.id,
        capabilityKind: entry.kind,
      },
    });
    return cloneServerCapability(entry);
  }

  registerModel(
    name: string,
    model: ModelAdapter,
    metadata?: Record<string, unknown>,
  ): ServerCapabilityBinding<ModelAdapter> {
    return this.register({
      kind: "model",
      name,
      value: model,
      metadata,
    });
  }

  registerTool(
    tool: ToolDefinition,
    metadata?: Record<string, unknown>,
  ): ServerCapabilityBinding<ToolDefinition> {
    return this.register({
      kind: "tool",
      name: tool.name,
      description: tool.description,
      value: tool,
      metadata,
    });
  }

  registerPolicy(
    name: string,
    policy: Policy,
    metadata?: Record<string, unknown>,
  ): ServerCapabilityBinding<Policy> {
    return this.register({
      kind: "policy",
      name,
      value: policy,
      metadata,
    });
  }

  get<TValue = unknown>(
    id: string,
  ): ServerCapabilityBinding<TValue> | undefined {
    const entry = this.entries.get(id);
    return entry
      ? cloneServerCapability(entry as ServerCapabilityBinding<TValue>)
      : undefined;
  }

  getByName<TValue = unknown>(
    kind: ServerCapabilityKind,
    name: string,
  ): ServerCapabilityBinding<TValue> | undefined {
    return this.get<TValue>(`${kind}:${name}`);
  }

  list(
    filter: { kind?: ServerCapabilityKind } = {},
  ): ServerCapabilityBinding[] {
    return [...this.entries.values()]
      .filter((entry) => !filter.kind || entry.kind === filter.kind)
      .map((entry) => cloneServerCapability(entry));
  }

  unregister(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    this.hub?.publish({
      type: "capability.unregistered",
      payload: describeServerCapability(entry),
      metadata: {
        capabilityId: entry.id,
        capabilityKind: entry.kind,
      },
    });
    return true;
  }
}

export interface CreateManagedRunOptions extends CreateRunOptions {
  sessionId?: string;
  autoStart?: boolean;
}

export interface RunManagerOptions {
  hub?: ConnectionHub;
  sessionManager?: SessionManager;
  approvalBroker?: ApprovalBroker;
  capabilities?: ServerCapabilityRegistry;
  defaults?: Partial<CreateRunOptions>;
}

export class RunManager {
  private readonly runs = new Map<string, RunHandle>();
  private readonly runResults = new Map<string, Promise<RunResult>>();
  private readonly hub?: ConnectionHub;
  private readonly sessionManager?: SessionManager;
  private readonly approvalBroker?: ApprovalBroker;
  private readonly capabilities?: ServerCapabilityRegistry;
  private readonly defaults: Partial<CreateRunOptions>;

  constructor(options: RunManagerOptions = {}) {
    this.hub = options.hub;
    this.sessionManager = options.sessionManager;
    this.approvalBroker = options.approvalBroker;
    this.capabilities = options.capabilities;
    this.defaults = options.defaults ?? {};
  }

  createRun(options: CreateManagedRunOptions): RunHandle {
    const sessionId = options.sessionId;
    const run = createCoreRun(this.resolveRunOptions(options));
    this.runs.set(run.record.id, run);
    this.hub?.attachRun(run, sessionId ? { sessionId } : {});
    this.hub?.publish({
      type: "run.created",
      payload: {
        run: run.record,
        sessionId,
      },
      metadata: {
        runId: run.record.id,
        ...(sessionId ? { sessionId } : {}),
      },
    });

    if (sessionId && this.sessionManager) {
      void this.sessionManager.appendRun(sessionId, run.record.id);
    }

    if (options.autoStart) {
      void this.startRun(run.record.id);
    }
    return run;
  }

  getRun(id: string): RunHandle | undefined {
    return this.runs.get(id);
  }

  listRuns(): RunHandle[] {
    return [...this.runs.values()];
  }

  startRun(id: string): Promise<RunResult> {
    const run = this.mustGetRun(id);
    const existing = this.runResults.get(id);
    if (existing) return existing;

    const started = run.start().then((result) => {
      this.hub?.publish({
        type: "run.result",
        payload: {
          runId: run.record.id,
          result,
        },
        metadata: {
          runId: run.record.id,
        },
      });
      return result;
    });
    this.runResults.set(id, started);
    return started;
  }

  cancelRun(
    id: string,
    input: { reason?: string; metadata?: Record<string, unknown> } = {},
  ): RunResult {
    const run = this.mustGetRun(id);
    const result = run.cancel(input);
    this.hub?.publish({
      type: "run.cancelled",
      payload: {
        runId: run.record.id,
        result,
      },
      metadata: {
        runId: run.record.id,
        ...(input.metadata ?? {}),
      },
    });
    return result;
  }

  subscribeRun(
    id: string,
    subscriber: ServerRuntimeSubscriber,
    eventTypes?: EventType[],
  ): ServerRuntimeSubscription {
    return this.requireHub().subscribe(
      {
        runIds: [id],
        eventTypes,
      },
      subscriber,
    );
  }

  private resolveRunOptions(
    options: CreateManagedRunOptions,
  ): CreateRunOptions {
    const { sessionId, autoStart: _autoStart, ...coreOptions } = options;
    const metadata = {
      ...(this.defaults.metadata ?? {}),
      ...(coreOptions.metadata ?? {}),
      ...(sessionId ? { sessionId } : {}),
    };
    const capabilityTools = this.capabilities
      ?.list({ kind: "tool" })
      .map((entry) => entry.value as ToolDefinition);
    const explicitApprovalResolver =
      coreOptions.approvalResolver ?? this.defaults.approvalResolver;
    const brokerChannel = explicitApprovalResolver
      ? undefined
      : this.approvalBroker?.createInteractionChannel({
          metadata: sessionId ? { sessionId } : undefined,
        });

    return {
      ...this.defaults,
      ...coreOptions,
      metadata,
      tools: [
        ...(this.defaults.tools ?? []),
        ...(capabilityTools ?? []),
        ...(coreOptions.tools ?? []),
      ],
      interactionChannel:
        coreOptions.interactionChannel ??
        this.defaults.interactionChannel ??
        brokerChannel,
    };
  }

  private mustGetRun(id: string): RunHandle {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Run not found: ${id}`);
    return run;
  }

  private requireHub(): ConnectionHub {
    if (!this.hub) {
      throw new Error("RunManager requires a ConnectionHub for subscriptions.");
    }
    return this.hub;
  }
}

export interface SessionManagerOptions {
  store?: SessionStore | AppendOnlySessionStore;
  hub?: ConnectionHub;
}

export class SessionManager {
  private readonly store: SessionStore | AppendOnlySessionStore;
  private readonly hub?: ConnectionHub;

  constructor(options: SessionManagerOptions = {}) {
    this.store = options.store ?? new InMemorySessionStore();
    this.hub = options.hub;
  }

  async createSession(seed: Partial<Session> = {}): Promise<Session> {
    const session = await this.store.create(seed);
    this.hub?.publish({
      type: "session.created",
      payload: session,
      metadata: {
        sessionId: session.id,
      },
    });
    return session;
  }

  getSession(id: string): Promise<Session | null> {
    return this.store.get(id);
  }

  listSessions(opts: { limit?: number } = {}): Promise<Session[]> {
    return this.store.list(opts);
  }

  async appendRun(id: string, runId: RunId): Promise<Session> {
    const session = await this.store.append(id, runId);
    this.hub?.publish({
      type: "session.updated",
      payload: session,
      metadata: {
        sessionId: session.id,
        runId,
      },
    });
    return session;
  }

  async appendEvent<TPayload>(
    id: string,
    event: SessionEventInput<TPayload>,
  ): Promise<SessionRecord["eventCount"] | undefined> {
    if (!isAppendOnlySessionStore(this.store)) return undefined;
    const appended = await this.store.appendEvent(id, event);
    const session = await this.store.get(id);
    this.hub?.publish({
      type: "session.updated",
      payload: {
        session,
        event: appended,
      },
      metadata: {
        sessionId: id,
      },
    });
    return session?.eventCount;
  }
}

export interface CreateServerRuntimeOptions {
  hub?: ConnectionHub;
  approvalBroker?: ApprovalBroker;
  sessionManager?: SessionManager;
  capabilities?: ServerCapabilityRegistry;
  runDefaults?: Partial<CreateRunOptions>;
}

export interface ServerRuntime {
  hub: ConnectionHub;
  approvals: ApprovalBroker;
  sessions: SessionManager;
  capabilities: ServerCapabilityRegistry;
  runs: RunManager;
  commands: DurableCommandDispatcher;
}

export function createServerRuntime(
  options: CreateServerRuntimeOptions = {},
): ServerRuntime {
  const hub = options.hub ?? new ConnectionHub();
  const approvals = options.approvalBroker ?? new ApprovalBroker({ hub });
  const sessions = options.sessionManager ?? new SessionManager({ hub });
  const capabilities =
    options.capabilities ?? new ServerCapabilityRegistry(hub);
  const runs = new RunManager({
    hub,
    approvalBroker: approvals,
    sessionManager: sessions,
    capabilities,
    defaults: options.runDefaults,
  });
  const commands = new DurableCommandDispatcher();

  hub.publish({
    type: "runtime.ready",
    payload: {
      package: "@sparkwright/server-runtime",
    },
    metadata: {},
  });

  return {
    hub,
    approvals,
    sessions,
    capabilities,
    runs,
    commands,
  };
}

function normalizeFilter(
  filter: ServerRuntimeSubscriptionFilter,
): ServerRuntimeSubscriptionFilter {
  return {
    types: filter.types ? [...filter.types] : undefined,
    runIds: filter.runIds ? [...filter.runIds] : undefined,
    sessionIds: filter.sessionIds ? [...filter.sessionIds] : undefined,
    eventTypes: filter.eventTypes ? [...filter.eventTypes] : undefined,
  };
}

function matchesFilter(
  filter: ServerRuntimeSubscriptionFilter,
  message: ServerRuntimeMessage,
): boolean {
  if (filter.types && !filter.types.includes(message.type)) return false;

  const runId = stringMetadata(message.metadata, "runId");
  if (filter.runIds && (!runId || !filter.runIds.includes(runId))) {
    return false;
  }

  const sessionId = stringMetadata(message.metadata, "sessionId");
  if (
    filter.sessionIds &&
    (!sessionId || !filter.sessionIds.includes(sessionId))
  ) {
    return false;
  }

  const eventType = stringMetadata(message.metadata, "eventType");
  if (
    filter.eventTypes &&
    (!eventType || !filter.eventTypes.includes(eventType as EventType))
  ) {
    return false;
  }

  return true;
}

function describeServerCapability(
  entry: ServerCapabilityBinding,
): Omit<ServerCapabilityBinding, "value"> {
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    description: entry.description,
    metadata: { ...entry.metadata },
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function cloneServerCapability<TValue>(
  entry: ServerCapabilityBinding<TValue>,
): ServerCapabilityBinding<TValue> {
  return {
    ...entry,
    metadata: { ...entry.metadata },
  };
}

function isAppendOnlySessionStore(
  store: SessionStore | AppendOnlySessionStore,
): store is AppendOnlySessionStore {
  return "appendEvent" in store && "loadEvents" in store;
}

function stringMetadata(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
