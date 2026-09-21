export interface RunPaths {
  readonly repository: string;
  readonly commonDir: string;
  readonly root: string;
  readonly manifest: string;
  readonly events: string;
  readonly state: string;
  readonly lease: string;
  readonly lockDir: string;
  readonly artifacts: string;
  readonly assignments: string;
  readonly workers: string;
  readonly evidence: string;
  readonly logs: string;
}

export interface LeaseRecord {
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly acquiredAt: string;
}
