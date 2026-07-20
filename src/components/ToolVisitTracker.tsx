import { useEffect } from "react";
import { recordToolVisit } from "../lib/tool-memory";

export type ToolVisitTrackerProps = {
  slug: string;
};

/** Records only the tool slug and visit timestamp; it receives no tool input. */
export default function ToolVisitTracker({ slug }: ToolVisitTrackerProps) {
  useEffect(() => {
    recordToolVisit(slug);
  }, [slug]);

  return null;
}
