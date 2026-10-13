import { Card, CardHeader } from "@recx/design";

/** One report section: a titled card around a figure-table. */
export function ReportSection({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={`overflow-hidden ${className ?? ""}`}>
      <CardHeader title={title} subtitle={subtitle} />
      <div className="pb-4 pt-3">{children}</div>
    </Card>
  );
}
