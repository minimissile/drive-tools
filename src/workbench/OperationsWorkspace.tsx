import { useAppNavigation } from "../state";
import type { ReactNode } from "react";
import { Button, Header } from "../ui/primitives";
import { operationEntries } from "../zhidao/navigation";
import "./operations.css";
export function OperationsWorkspace({
  title,
  description,
  children,
  action,
  className = "",
}: {
  title: string;
  description: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const { page, navigate } = useAppNavigation();
  const zhidao = operationEntries.some((entry) => entry.page === page);
  return (
    <div className={`operations-workspace ${className}`}>
      <Header
        title={title}
        description={description}
        action={
          action ??
          (zhidao ? (
            <Button quiet onClick={() => navigate("zhidao-accounts")}>
              管理知道账号
            </Button>
          ) : undefined)
        }
      />
      {children}
    </div>
  );
}
