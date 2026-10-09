import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { DISC_SIZE, renderDisc } from "../lib/disc";

/**
 * A catalogue card's planet: the surface its run recorded.
 *
 * The last readable step, sampled by nearest cell and coloured on the same ramp
 * and the same auto range the viewer opens with — so the card and the globe are
 * pictures of the same thing, and picking one out of the grid means something.
 *
 * A body with no readable step yet keeps the plain disc. **Absent is drawn as
 * absent:** a card must never show a surface for a run that has not produced one.
 */
export function PlanetDisc(props: { jobId: string | null; name: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const jobId = props.jobId;
    if (!jobId) return;
    const ctrl = new AbortController();
    let live = true;

    void (async () => {
      try {
        const { steps } = await api.steps(jobId, ctrl.signal);
        const last = steps[steps.length - 1];
        if (last === undefined) return;
        const frame = await api.step(jobId, last, ["elevation"], ctrl.signal);
        const cloud = frame.domains["cloud"];
        const elevation = frame.fields["elevation"];
        if (!live || !cloud || !elevation) return;

        const pixels = renderDisc(DISC_SIZE, cloud.pos, elevation.values as number[]);
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        canvas.width = pixels.width;
        canvas.height = pixels.height;
        // A fresh ImageData rather than one wrapping the array: the typed-array
        // constructor overload is not portable across DOM lib versions, and a
        // copy of 112² pixels is nothing.
        const image = ctx.createImageData(pixels.width, pixels.height);
        image.data.set(pixels.data);
        ctx.putImageData(image, 0, 0);
        setDrawn(true);
      } catch {
        // A card that cannot read its run shows no surface. It is a thumbnail:
        // failing to draw one is not worth an error in front of the catalogue.
      }
    })();

    return () => { live = false; ctrl.abort(); };
  }, [props.jobId]);

  return (
    <div
      className="card__disc"
      title={drawn
        ? `${props.name}: elevation of the last recorded step, same colours as the viewer`
        : "No recorded step to draw yet"}
    >
      <canvas ref={canvasRef} className="card__canvas" data-drawn={drawn} />
    </div>
  );
}
