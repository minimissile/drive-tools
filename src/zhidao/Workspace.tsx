import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useAppNavigation } from "../state";
import { Button, Header } from "../ui/primitives";
import { operationEntries } from "./navigation";
import "./zhidao.css";
export function OperationsWorkspace({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  const { page, navigate } = useAppNavigation();
  return (
    <div className="operations-workspace">
      <div className="operations-breadcrumb">
        <Button quiet size="compact" onClick={() => navigate("workbench")}>
          <ArrowLeft size={14} />
          工作台
        </Button>
        <span>/</span>
        <span>{title}</span>
      </div>
      <Header title={title} description={description} />
      <nav className="operations-nav" aria-label="百度知道运营">
        <div>
          {operationEntries.map((entry) => (
            <button
              key={entry.page}
              aria-current={page === entry.page ? "page" : undefined}
              onClick={() => navigate(entry.page)}
            >
              {entry.title}
              <ArrowRight size={12} />
            </button>
          ))}
        </div>
      </nav>
      {children}
    </div>
  );
}
