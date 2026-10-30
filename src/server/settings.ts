import type { Backend } from "../teacher.ts";
import type * as http from "node:http";
import {
  connectionSettings,
  learnerPreferences,
  reviewSettings,
  saveConnectionSettings,
  saveLearnerPreferences,
  saveReviewSettings,
} from "../settings.ts";
import { classroomDir, isValidSlug } from "../paths.ts";
import * as store from "../store.ts";
import { getPort } from "../server.ts";
import { teacherModels } from "../teacher.ts";
import { hooks } from "./hooks.ts";
import { readJsonBody, sendJson } from "./http.ts";

let applyingConnection = false;
export async function handleSettings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  models = false,
): Promise<void> {
  try {
    const classroom = url.searchParams.get("classroom");
    if (!isValidSlug(classroom) || !store.readClassroom(classroom))
      return sendJson(res, { error: "Unknown classroom." }, 404);
    if (models) {
      if (req.method !== "GET") return sendJson(res, { error: "Use GET to load models." }, 405);
      const teacher = hooks?.teacherSettings?.(classroom) as {
        identity: { backend: Backend };
      } | null;
      if (!teacher)
        throw new Error(
          "Model selection requires an attached persistent teacher. Open this classroom from your agent first.",
        );
      return sendJson(res, await teacherModels(teacher.identity.backend, classroomDir(classroom)));
    }
    let applyError: string | undefined;
    let saved: string | undefined;
    if (req.method === "PUT") {
      const input = (await readJsonBody(req)) as {
        section?: unknown;
        revision?: unknown;
        values?: unknown;
      };
      if (
        !input ||
        typeof input !== "object" ||
        !input.values ||
        typeof input.values !== "object" ||
        Array.isArray(input.values)
      )
        throw new Error("Invalid settings request.");
      const values = input.values as Record<string, unknown>;
      if (input.section === "connection") {
        if (applyingConnection)
          throw new Error("Connection settings are being applied. Retry after that save finishes.");
        applyingConnection = true;
        try {
          saveConnectionSettings(values, input.revision);
          if (hooks?.applyConnectionSettings) {
            try {
              await hooks.applyConnectionSettings();
            } catch (error) {
              applyError = `Connection settings were saved, but links could not be applied: ${(error as Error).message} Save connection settings again to retry.`;
            }
          }
        } finally {
          applyingConnection = false;
        }
      } else if (input.section === "preferences")
        saveLearnerPreferences(classroom, values, input.revision);
      else if (input.section === "review") saveReviewSettings(classroom, values, input.revision);
      else if (input.section === "model") {
        if (!hooks?.setTeacherModel)
          throw new Error("Open this classroom from your agent to attach its persistent teacher.");
        if (Object.keys(values).length !== 1 || !("requestedModel" in values))
          throw new Error("Supply only requestedModel.");
        hooks.setTeacherModel(classroom, values.requestedModel, input.revision);
      } else throw new Error("Unknown settings section.");
      saved = input.section as string;
    } else if (req.method !== "GET")
      return sendJson(res, { error: "Use GET or PUT for settings." }, 405);
    return sendJson(res, {
      connection: connectionSettings(),
      preferences: learnerPreferences(classroom),
      review: reviewSettings(classroom),
      teacher: hooks?.teacherSettings?.(classroom) ?? null,
      host: hooks?.delivery === "service" ? "service" : "pi",
      currentPort: getPort(),
      saved,
      applyError,
    });
  } catch (error) {
    sendJson(res, { error: (error as Error).message }, 400);
  }
}
