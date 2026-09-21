import type {
  VerificationObservation,
  VerificationObservationStore,
} from "../../actions/git-project-task-status.js";
import type { Journal } from "../../state/journal.js";

export class JournalVerificationObservations implements VerificationObservationStore {
  public constructor(private readonly journal: Journal) {}

  public async get(id: string): Promise<VerificationObservation | undefined> {
    const matches: VerificationObservation[] = [];
    for (const event of await this.journal.read()) {
      if (
        (event.idempotencyKey !== id && !event.idempotencyKey.endsWith(`:${id}`)) ||
        (event.eventType !== "verification.passed" &&
          event.eventType !== "verification.failed")
      ) continue;
      const payload = event.payload as { commit?: unknown };
      if (typeof payload.commit !== "string") return undefined;
      matches.push({ eventType: event.eventType, commit: payload.commit });
    }
    return matches.length === 1 ? matches[0] : undefined;
  }
}
