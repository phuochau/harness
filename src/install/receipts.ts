import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface InstallReceipt {
  readonly schemaVersion: 1;
  readonly planHash: string;
  readonly stepId: string;
  readonly status: "completed" | "failed";
  readonly recordedAt: string;
  readonly version?: string;
  readonly reason?: string;
}

function assertSafeReceipt(receipt: InstallReceipt): void {
  for (const value of [receipt.planHash, receipt.stepId, receipt.version, receipt.reason]) {
    if (value !== undefined && /(?:token|password|secret|authorization)=/i.test(value)) {
      throw new Error("install receipt contains forbidden secret-shaped data");
    }
  }
}

export class ReceiptStore {
  public constructor(private readonly path: string) {}

  public async completed(planHash: string, stepId: string): Promise<boolean> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      const receipt = JSON.parse(line) as Partial<InstallReceipt>;
      if (
        receipt.planHash === planHash &&
        receipt.stepId === stepId &&
        receipt.status === "completed"
      ) return true;
    }
    return false;
  }

  public async append(receipt: InstallReceipt): Promise<void> {
    assertSafeReceipt(receipt);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const file = await open(this.path, "a", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(this.path, 0o600);
  }
}
