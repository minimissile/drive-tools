import { Composition, registerRoot } from "remotion";
import {
  VIDEO_COMPOSITION_ID,
  VIDEO_FPS,
  videoDimensions,
  videoProjectSchema,
} from "../shared/video";
import { VideoComposition } from "./VideoComposition";

const defaultProject = videoProjectSchema.parse({
  title: "资料目录",
  entries: [{ name: "请传入实际资料内容", kind: "folder" }],
});
function LocalVideoRoot() {
  return (
    <Composition
      id={VIDEO_COMPOSITION_ID}
      component={VideoComposition}
      fps={VIDEO_FPS}
      width={1080}
      height={1920}
      durationInFrames={360}
      defaultProps={{ project: defaultProject }}
      calculateMetadata={({ props }) => {
        const project = videoProjectSchema.parse(props.project);
        return {
          ...videoDimensions(project.aspectRatio),
          fps: VIDEO_FPS,
          durationInFrames: project.durationSeconds * VIDEO_FPS,
          props: { project },
        };
      }}
    />
  );
}
registerRoot(LocalVideoRoot);
