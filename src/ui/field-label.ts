import { createContext } from "react";

/** Share the visible label with composite controls without coupling to form state. */
export const FieldLabelContext = createContext<string | undefined>(undefined);
