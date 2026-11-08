import type { ComponentProps } from "react";
import type { SmzdmDetail } from "../../shared/smzdm";
import { ipc } from "../api/client";
import {
  ArticleResources as ResourcePanel,
  type ArticleResourceActions,
} from "../articles/ArticleResources";
const actions: ArticleResourceActions<SmzdmDetail> = {
  sync: (id) => ipc("smzdm.syncLinks", { id }),
  bind: (id, linkId, copyId) =>
    ipc("smzdm.bindResource", { id, linkId, copyId }),
  create: (id, linkId, accountId) =>
    ipc("smzdm.resource", { id, linkId, accountId }),
};
export function ArticleResources(
  props: Omit<ComponentProps<typeof ResourcePanel<SmzdmDetail>>, "actions">,
) {
  return <ResourcePanel {...props} actions={actions} />;
}
