import { RenderJobHttpError, type RenderJobApi } from "../api/render-jobs";
import type { ProjectRecord } from "../domain";

/**
 * Delete every server job before removing browser-local metadata. A retry is
 * safe after a partial success because an already absent server job is treated
 * as deleted, while every other server failure leaves the local project intact.
 */
export async function deleteProjectWithServerJobs(
  api: RenderJobApi,
  project: ProjectRecord,
  deleteLocalProject: () => Promise<void>,
): Promise<void> {
  const jobIds = [...new Set(project.renders.flatMap((render) => render.server ? [render.server.jobId] : []))];
  for (const jobId of jobIds) {
    try {
      await api.deleteJob(jobId);
    } catch (error) {
      if (!isAlreadyDeleted(error)) throw error;
    }
  }
  await deleteLocalProject();
}

function isAlreadyDeleted(error: unknown): boolean {
  return error instanceof RenderJobHttpError
    && error.status === 404
    && error.code === "invalid_request";
}
