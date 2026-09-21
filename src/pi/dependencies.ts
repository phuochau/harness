import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface HarnessSessionDependencies {
  readonly cwd: string;
  readonly sessionFile?: string;
  dispose(): Promise<void>;
}

export interface HarnessSessionDependencyFactory {
  create(context: ExtensionContext): Promise<HarnessSessionDependencies>;
}

export interface LazyExtensionDependencies {
  start(context: ExtensionContext): Promise<HarnessSessionDependencies>;
  current(): HarnessSessionDependencies | undefined;
  dispose(): Promise<void>;
}

const defaultFactory: HarnessSessionDependencyFactory = {
  async create(context) {
    const sessionFile = context.sessionManager.getSessionFile();
    return {
      cwd: context.cwd,
      ...(sessionFile === undefined ? {} : { sessionFile }),
      async dispose() {},
    };
  },
};

export function createLazyExtensionDependencies(
  factory: HarnessSessionDependencyFactory = defaultFactory,
): LazyExtensionDependencies {
  let active: HarnessSessionDependencies | undefined;
  let starting: Promise<HarnessSessionDependencies> | undefined;
  return {
    async start(context) {
      if (active !== undefined) return active;
      if (starting !== undefined) return starting;
      starting = factory.create(context).then((created) => {
        active = created;
        return created;
      });
      try {
        return await starting;
      } finally {
        starting = undefined;
      }
    },
    current() {
      return active;
    },
    async dispose() {
      const dependency = active ?? (starting === undefined ? undefined : await starting);
      active = undefined;
      starting = undefined;
      await dependency?.dispose();
    },
  };
}
