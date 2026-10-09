import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import type { ExportSpec, JobStatus, PatchSpec } from "../api/types";

/** How often a running export is asked for its progress. */
const POLL_MS = 700;

/**
 * A baked heightmap.
 *
 * Polled rather than streamed: an export reports one number at human
 * speed and finishes in seconds, and a second SSE connection to carry it
 * would be machinery for nothing.
 */
export function useExportJob() {
  const [id, setId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!id) return;
    let live = true;

    const poll = async () => {
      try {
        const next = await api.exportStatus(id);
        if (!live) return;
        setStatus(next);
        if (next.state === "queued" || next.state === "running") {
          timer.current = window.setTimeout(() => void poll(), POLL_MS);
        }
      } catch (e) {
        if (live) setError(e instanceof ApiError ? e.message : String(e));
      }
    };
    void poll();

    return () => {
      live = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [id]);

  const start = useCallback(
    async (planetId: string, patch: PatchSpec, spec: ExportSpec) => {
      setError(null);
      setStatus(null);
      try {
        const { id: jobId } = await api.startExport(planetId, patch, spec);
        setId(jobId);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
      }
    },
    [],
  );

  const download = useCallback(() => {
    if (id) window.location.assign(api.exportArchiveUrl(id));
  }, [id]);

  return { status, error, start, download };
}
