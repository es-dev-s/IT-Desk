import { redirect } from "next/navigation";

/** Reports has no page of its own: open the first report. */
export default function ReportsPage() {
  redirect("/reports/members");
}
