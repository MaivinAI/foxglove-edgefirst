import {
  ImageAnnotations,
  PointsAnnotation,
  TextAnnotation,
  PointsAnnotationType,
  Color,
} from "@foxglove/schemas";
import { Time } from "@foxglove/schemas/schemas/typescript/Time";
import { ExtensionContext } from "@foxglove/studio";
type Header = {
  timestamp: Time;
  frame_id: string;
};

type DetectBoxes2D = {
  header: Header;
  inputTimestamp: Time;
  modelTime: Time;
  outputTime: Time;
  boxes: DetectBox2D[];
};

type DetectBox2D = {
  center_x: number;
  center_y: number;
  width: number;
  height: number;
  label: string;
  score: number;
  distance: number;
  speed: number;
  track: DetectTrack;
};
type DetectTrack = {
  id: string;
  lifetime: number;
  created: Time;
};

const WHITE: Color = { r: 1, g: 1, b: 1, a: 1 };
const TRANSPARENT: Color = { r: 1, g: 1, b: 1, a: 0 };

const CHARCODE_MINUS = "-".charCodeAt(0);
const CHARCODE_DOT = ".".charCodeAt(0);
const CHARCODE_a = "a".charCodeAt(0);
const CHARCODE_A = "A".charCodeAt(0);
const CHARCODE_0 = "0".charCodeAt(0);
function uuid_to_color(id: string): Color {
  let hexcode = 0;
  let bytes = 0;
  for (const char of id) {
    const c = char.charCodeAt(0);
    if (c === CHARCODE_MINUS || c === CHARCODE_DOT) {
      continue;
    }
    let val = 0;
    if (c >= CHARCODE_a) {
      val = c - CHARCODE_a + 10;
    } else if (c >= CHARCODE_A) {
      val = c - CHARCODE_A + 10;
    } else if (c >= CHARCODE_0) {
      val = c - CHARCODE_0;
    }
    hexcode = (hexcode << 4) + val;

    // printf("c: %c val: %i hexcode: %x\n", c, val, hexcode);
    bytes++;
    if (bytes >= 8) {
      break;
    }
  }

  return {
    r: ((hexcode >> 24) & 0xff) / 255.0,
    g: ((hexcode >> 16) & 0xff) / 255.0,
    b: ((hexcode >> 8) & 0xff) / 255.0,
    a: 1.0,
  };
}

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerMessageConverter({
    fromSchemaName: "edgefirst_msgs/msg/Detect",
    toSchemaName: "foxglove.ImageAnnotations",
    converter: (inputMessage: DetectBoxes2D): ImageAnnotations => {
      const points: PointsAnnotation[] = [];
      const texts: TextAnnotation[] = [];
      inputMessage.boxes.forEach((box: DetectBox2D) => {
        // The video is assumed to be 1920x1080 dimensions for this converter
        const x = box.center_x * 1920;
        const y = box.center_y * 1080;
        const width = box.width * 1920;
        const height = box.height * 1080;
        let box_color = WHITE;
        let label = box.label;
        if (box.track.id.length > 0) {
          box_color = uuid_to_color(box.track.id);
          label = box.track.id.substring(0, 8);
        }
        const new_point: PointsAnnotation = {
          timestamp: inputMessage.inputTimestamp,
          type: PointsAnnotationType.LINE_LOOP,
          points: [
            { x: x - width / 2, y: y - height / 2 },
            { x: x - width / 2, y: y + height / 2 },
            { x: x + width / 2, y: y + height / 2 },
            { x: x + width / 2, y: y - height / 2 },
          ],

          outline_color: box_color,
          outline_colors: [box_color, box_color, box_color, box_color],
          fill_color: TRANSPARENT,
          thickness: 9,
        };
        const new_text: TextAnnotation = {
          timestamp: inputMessage.inputTimestamp,
          position: { x: x - width / 2, y: y - height / 2 + 6 },
          text: label,
          font_size: 48,
          text_color: box_color,
          background_color: TRANSPARENT,
        };
        points.push(new_point);
        texts.push(new_text);
      });
      const new_annot: ImageAnnotations = {
        circles: [],
        points,
        texts,
      };
      return new_annot;
    },
  });
}
