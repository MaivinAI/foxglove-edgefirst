import {
  ImageAnnotations,
  PointsAnnotation,
  TextAnnotation,
  PointsAnnotationType,
  Color,
} from "@foxglove/schemas";
import { Time } from "@foxglove/schemas/schemas/typescript/Time";
import { ExtensionContext } from "@foxglove/studio";

type Boxes2D = {
  outputTime: Time;
  inputTime: Time;
  timingInfo: TimingInfo;
  boxes: Box[];
};

type TimingInfo = {
  inputTime: number;
  modelTime: number;
  outputTime: number;
};

type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
  label: number;
  score: number;
  distance: number;
  speed: number;
  trackID: string;
  lifetime: number;
};

const WHITE: Color = { r: 1, g: 1, b: 1, a: 1 };
const TRANSPARENT: Color = { r: 1, g: 1, b: 1, a: 0 };

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerMessageConverter({
    fromSchemaName: "edgefirstmsg/msgs/Boxes2D",
    toSchemaName: "foxglove.ImageAnnotations",
    converter: (inputMessage: Boxes2D): ImageAnnotations => {
      const points: PointsAnnotation[] = [];
      const texts: TextAnnotation[] = [];
      inputMessage.boxes.forEach((box: Box) => {
        const x = box.x * 1920;
        const y = box.y * 1080;
        const width = box.width * 1920;
        const height = box.height * 1080;
        const new_point: PointsAnnotation = {
          timestamp: inputMessage.inputTime,
          type: PointsAnnotationType.LINE_LOOP,
          points: [
            { x: x - width / 2, y: y - height / 2 },
            { x: x - width / 2, y: y + height / 2 },
            { x: x + width / 2, y: y + height / 2 },
            { x: x + width / 2, y: y - height / 2 },
          ],

          outline_color: WHITE,
          outline_colors: [WHITE, WHITE, WHITE, WHITE],
          fill_color: WHITE,
          thickness: 3,
        };
        const new_text: TextAnnotation = {
          timestamp: inputMessage.inputTime,
          position: { x: x - width / 2, y: y - height / 2 + 4 },
          text: box.label.toLocaleString(),
          font_size: 24,
          text_color: WHITE,
          background_color: TRANSPARENT,
        };
        points.push(new_point);
        texts.push(new_text);
      });
      return { circles: [], points, texts };
    },
  });
}
