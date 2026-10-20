import { useState } from "react";
import Bulk from "./Bulk";
import Batch from "./Batch";
import { BatchInsertion } from "../batch/BatchInsertion";
import { Header, Notice } from "../ui/primitives";
import { Tabs, TabList, TabPanel } from "../ui/Tabs";
import { useAppNavigation } from "../state";
export default function BatchProcessing() {
  const { page } = useAppNavigation();
  const [tab, setTab] = useState<"import" | "transfer" | "insert">(
    page === "bulk" ? "import" : "transfer",
  );
  const [seed, setSeed] = useState<string[]>();
  const [importedTotal, setImportedTotal] = useState(0);
  return (
    <>
      <Header
        title="批量处理"
        description="添加资料、检查转存和插入素材，在同一工作区完成。"
      />
      <Tabs<"import" | "transfer" | "insert"> value={tab} onChange={setTab}>
        <TabList
          label="批量处理步骤"
          items={[
            ["import", "1 · 添加资料"],
            ["transfer", "2 · 检查并转存"],
            ["insert", "批量插入"],
          ]}
        />
        <TabPanel value="import" keepMounted>
          <Bulk
            embedded
            onImported={(ids) => {
              setImportedTotal(ids.length);
              setSeed(ids.slice(0, 100));
              setTab("transfer");
            }}
          />
        </TabPanel>
        <TabPanel value="transfer" keepMounted>
          {importedTotal > 100 ? (
            <Notice>
              本次选入 100
              份草稿。其余已导入资料仍在下方草稿列表，可另建批次处理。
            </Notice>
          ) : null}
          <Batch embedded seed={seed} onImport={() => setTab("import")} />
        </TabPanel>
        <TabPanel value="insert" keepMounted>
          <BatchInsertion />
        </TabPanel>
      </Tabs>
    </>
  );
}
