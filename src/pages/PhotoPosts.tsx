import { useState } from "react";
import { Plus } from "lucide-react";
import { photoProviders, type PhotoPost } from "../../shared/photo-posts";
import type { Resource, ResourceCopy } from "../../shared/types";
import { useAppData, useAppNavigation, useAppSelection } from "../state";
import { useIpcQuery } from "../api/useIpcQuery";
import { windowStorage } from "../storage/window-storage";
import { ResourcePicker, ResourceRequired } from "../resources/components";
import { Header, Button, Notice, LoadingState } from "../ui/primitives";
import { QueryError } from "../ui/QueryError";
import { Select } from "../ui/Select";
import { PhotoEditor } from "../photo-posts/PhotoEditor";
import "../photo-posts/photo-posts.css";

export default function PhotoPosts() {
  const { data } = useAppData(),
    { resource, copy } = useAppSelection(),
    { edit } = useAppNavigation();
  return (
    <div className="photo-posts">
      <Header
        title="资源图文营销"
        description="选择本人资源，补填中文口令，制作三张图并交付到平台官网。"
        action={
          <Button size="compact" onClick={() => edit(null)}>
            <Plus size={14} />
            录入并转存资源
          </Button>
        }
      />
      <ResourceRequired>
        <ResourcePicker />
        {resource && copy ? (
          (photoProviders as readonly string[]).includes(resource.provider) ? (
            <PhotoWorkspace
              key={`${data!.dataPath}:${copy.id}`}
              resource={resource}
              copy={copy}
            />
          ) : (
            <Notice warning>
              目前支持夸克、百度、UC 和迅雷，请选择对应资源。
            </Notice>
          )
        ) : null}
      </ResourceRequired>
    </div>
  );
}
function PhotoWorkspace({
  resource,
  copy,
}: {
  resource: Resource;
  copy: ResourceCopy;
}) {
  const { data } = useAppData();
  const history = useIpcQuery(
    "photoPosts.list",
    { copyId: copy.id },
    {
      keepPrevious: true,
      invalidate: data,
    },
  );
  const key = `panxu-photo-selection:${data!.dataPath}:${copy.id}`;
  const [selected, setSelected] = useState(() => {
    try {
      return windowStorage.getItem(key) || "";
    } catch {
      return "";
    }
  });
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const tasks = history.data?.filter((post) => post.copyId === copy.id) ?? [];
  const selectedPost = useIpcQuery(
    "photoPosts.get",
    { id: selected, copyId: copy.id },
    { enabled: !!selected && !tasks.some((post) => post.id === selected) },
  );
  const current =
    tasks.find((post) => post.id === selected) ?? selectedPost.data;
  const choices =
    current && !tasks.some((post) => post.id === current.id)
      ? [current, ...tasks]
      : tasks;
  const choose = (id: string) => {
    setSelected(id);
    try {
      windowStorage.setItem(key, id);
    } catch {
      /* The editor reports form recovery failures separately. */
    }
  };
  const taskToolbar = (
    <div className="photo-post-toolbar">
      <Select
        disabled={busy}
        aria-label="图文任务"
        value={current?.id ?? ""}
        items={[
          { value: "", label: "新建图文" },
          ...choices.map((post) => ({
            value: post.id,
            label: `${post.form.title} · v${post.version}`,
          })),
        ]}
        onValueChange={choose}
      />
      <Button
        size="compact"
        disabled={busy}
        onClick={() => {
          choose("");
          setNonce((n) => n + 1);
        }}
      >
        <Plus size={14} />
        新建图文
      </Button>
    </div>
  );
  return (
    <>
      {!history.data ? taskToolbar : null}
      <QueryError
        error={history.error}
        loading={history.loading}
        onRetry={history.reload}
      />
      <QueryError
        error={selectedPost.error}
        loading={selectedPost.loading}
        onRetry={selectedPost.reload}
      />
      {(!history.data && !history.error) ||
      (selected && !current && selectedPost.loading) ? (
        <LoadingState label="正在读取图文任务…" />
      ) : history.data && (!selected || current) ? (
        <PhotoEditor
          key={`${current?.id ?? "new"}:${nonce}`}
          resource={resource}
          copy={copy}
          toolbar={taskToolbar}
          busy={busy}
          setBusy={setBusy}
          post={current ?? null}
          onSaved={async (post) => {
            await history.reload();
            choose(post.id);
          }}
        />
      ) : null}
    </>
  );
}
