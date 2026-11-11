// The Ego engine: connectEgo selects an Ego task space and opens a BrowserConnection over
// EgoCdpClient, the CDP client on Ego Lite's native bindings.
import { BrowserConnection } from "../connection.ts";
import type { ConnectEgoOptions, EgoBindings, EgoTaskSpace, TaskSpaceSelection } from "./bindings.ts";
import { EgoCdpClient } from "./cdp-client.ts";
import { EgoCdpError, requireEgo } from "./errors.ts";

export { EgoCdpClient } from "./cdp-client.ts";
export { EgoCdpError } from "./errors.ts";

// Ego sends raw CDP only for the task space the script selected and the agent owns. By default a
// new agent task space is created; pass `taskSpace` (a numeric id the agent already claimed) to reuse one.
async function selectTaskSpace(
  ego: EgoBindings,
  { taskSpace, taskName, profileId }: TaskSpaceSelection,
): Promise<EgoTaskSpace> {
  if (taskSpace !== undefined) {
    if (!Number.isInteger(taskSpace))
      throw new TypeError("taskSpace is Ego's numeric task-space id (ego.listTaskSpaces()[i].id)");
    ego.useTaskSpace(taskSpace);
    return { id: taskSpace };
  }
  if (typeof ego.createTaskSpace !== "function" || typeof ego.useTaskSpace !== "function") {
    throw new EgoCdpError(
      "ego_task_space_unsupported",
      "this Ego runtime has no createTaskSpace/useTaskSpace; pass taskSpace with an id the agent already claimed",
    );
  }
  const created = await ego.createTaskSpace(taskName ?? `omowright-${Date.now()}`, ...(profileId ? [profileId] : []));
  if (!created || created.error) {
    throw new EgoCdpError(
      String(created?.error_code ?? "ego_task_space_failed"),
      `Ego could not create a task space: ${created?.error ?? "no result"}`,
    );
  }
  ego.useTaskSpace(created.id);
  return created;
}

export async function connectEgo({
  ego: egoOption = globalThis.ego,
  taskSpace,
  taskName,
  profileId,
  storageRoot,
  commandTimeoutMs,
  logId,
  dialogPolicy,
}: ConnectEgoOptions = {}) {
  const ego = requireEgo(egoOption);
  const client = new EgoCdpClient({ ego, commandTimeoutMs, logId, dialogPolicy });
  // Selecting a task space switches it for every client in this runtime, so refuse before that.
  if (ego.onCDPMessage || ego.onSendCDPMessageError) {
    throw new EgoCdpError(
      "ego_busy",
      "another client already holds Ego's CDP callbacks in this runtime; close it first",
    );
  }
  const space = await selectTaskSpace(ego, { taskSpace, taskName, profileId });
  await client.ensureConnected();
  const connection = new BrowserConnection(client, { storageRoot });
  await connection.initialize();
  return Object.assign(connection, { engine: "ego" as const, taskSpace: space });
}
