import { saveContentImage } from "../content-assets";
export const saveZhihuImage = (dataPath: string, bytes: Buffer, name: string) =>
  saveContentImage(dataPath, bytes, name, "zhihu-assets");
