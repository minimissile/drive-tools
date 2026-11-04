import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { stableContext } from "../lib/stable-context";
import { useAppNavigation } from "../state";

export interface OperationsDestination {
  planId: string;
  tab: "autonomy" | "plans" | "participation";
}
interface FocusRequest extends OperationsDestination {
  token: number;
}
const Context = stableContext<{
  focus: FocusRequest | null;
  open(destination: OperationsDestination): void;
  consume(token: number): void;
} | null>("OperationsFocus", null);

/** Same-window navigation intent only. Never saves execution or fee authorization. */
export function OperationsFocusProvider({ children }: { children: ReactNode }) {
  const { navigate } = useAppNavigation();
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const serial = useRef(0);
  const open = useCallback(
    (destination: OperationsDestination) => {
      setFocus({ ...destination, token: ++serial.current });
      navigate("intelligent-operations");
    },
    [navigate],
  );
  const consume = useCallback(
    (token: number) =>
      setFocus((current) => (current?.token === token ? null : current)),
    [],
  );
  const value = useMemo(
    () => ({ focus, open, consume }),
    [focus, open, consume],
  );
  return <Context value={value}>{children}</Context>;
}
export function useOperationsFocus() {
  const value = useContext(Context);
  if (!value) throw new Error("OperationsFocusProvider missing");
  return value;
}
