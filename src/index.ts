import {
  ImageAnnotations,
  PointsAnnotation,
  Point2,
  PointsAnnotationType,
  RawImage,
  Color,
  SceneEntity,
  SceneUpdate,
  TextAnnotation,
  LinePrimitive,
  LineType,
  TextPrimitive,
} from "@foxglove/schemas";
import { Time } from "@foxglove/schemas/schemas/typescript/Time";
import { ExtensionContext } from "@foxglove/studio";
import CV from "@techstark/opencv-js";
import zstd from "zstandard-wasm";

declare global {
  interface Window {
    cv: typeof import("mirada/dist/src/types/opencv/_types");
  }
}

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

type Mask = {
  height: number;
  width: number;
  length: number;
  encoding: string;
  mask: Uint8Array;
};

type RadarCube = {
  header: Header;
  timestamp: number;
  layout: Uint8Array;
  shape: Uint16Array;
  scales: Float32Array;
  cube: Int16Array;
  is_complex: boolean;
};

const WHITE: Color = { r: 1, g: 1, b: 1, a: 1 };
const WHITE_I8: Color = { r: 255, g: 255, b: 255, a: 255 };
const TRANSPARENT: Color = { r: 1, g: 1, b: 1, a: 0 };

const CLASS_COLORS_F: Color[] = [];
// color list from https://sashamaps.net/docs/resources/20-colors/
const CLASS_COLORS_I8: Color[] = [
  { r: 0, g: 0, b: 0, a: 0 },
  { r: 230, g: 25, b: 75, a: 200 },
  { r: 60, g: 180, b: 75, a: 200 },
  { r: 255, g: 225, b: 25, a: 200 },
  { r: 0, g: 130, b: 200, a: 200 },
  { r: 245, g: 130, b: 48, a: 200 },
  { r: 145, g: 30, b: 180, a: 200 },
  { r: 70, g: 240, b: 240, a: 200 },
  { r: 240, g: 50, b: 230, a: 200 },
  { r: 210, g: 245, b: 60, a: 200 },
  { r: 250, g: 190, b: 212, a: 200 },
  { r: 0, g: 128, b: 128, a: 200 },
  { r: 220, g: 190, b: 255, a: 200 },
  { r: 170, g: 110, b: 40, a: 200 },
  { r: 255, g: 250, b: 200, a: 200 },
  { r: 128, g: 0, b: 0, a: 200 },
  { r: 170, g: 255, b: 195, a: 200 },
  { r: 128, g: 128, b: 0, a: 200 },
  { r: 255, g: 215, b: 180, a: 200 },
  { r: 0, g: 0, b: 128, a: 200 },
  { r: 128, g: 128, b: 128, a: 200 },
  // { r: 0, g: 0, b: 0, a: 200 }
];
const COLOR_I_TO_F = 1.0 / 255.0;
CLASS_COLORS_I8.forEach((c) => {
  CLASS_COLORS_F.push({
    r: COLOR_I_TO_F * c.r,
    g: COLOR_I_TO_F * c.g,
    b: COLOR_I_TO_F * c.b,
    a: COLOR_I_TO_F * c.a,
  });
});

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

const RADAR_SEQ_VAR = "radar_seq";
const RADAR_RX_VAR = "radar_rx";
const BOX_LABEL_VAR = "box_label";

let radarcube_sequence = "";
let radarcube_rx = 0;
let box_label = "";
function registerGlobalVariableGetter(extensionContext: ExtensionContext): void {
  extensionContext.registerTopicAliases((args) => {
    const { globalVariables } = args;
    box_label = String(globalVariables[BOX_LABEL_VAR] ?? "");
    radarcube_sequence = String(globalVariables[RADAR_SEQ_VAR] ?? "");
    const rx = Number(globalVariables[RADAR_RX_VAR] ?? 0);
    if (isFinite(rx)) {
      radarcube_rx = rx;
    } else {
      radarcube_rx = -1;
    }
    return [];
  });
}

const cyrb53 = (str: string, seed = 0) => {
  let h1 = 0xdeadbeef ^ seed,
    h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};
function str_to_color(str: string): Color {
  const hash = cyrb53(str);

  return {
    r: (hash & 0xff) / 0xff,
    g: (hash & 0xff00) / 0xff00,
    b: (hash & 0xff0000) / 0xff00000,
    a: 1,
  };
}

function box_to_color_label(box: DetectBox2D): [Color, string] {
  let box_color = str_to_color(box.label);
  let label = box.label;
  switch (box_label.toLowerCase()) {
    case "label":
      break;
    case "score":
      label = box.score.toFixed(2);
      break;
    case "label-score":
      label = `${box.label} ${box.score.toFixed(2)}`;
      break;
    default: // case "track":
      if (box.track.id.length > 0) {
        label = box.track.id.substring(0, 8);
        box_color = uuid_to_color(box.track.id);
      }
      break;
  }
  return [box_color, label];
}

function registerDetectConverter(extensionContext: ExtensionContext): void {
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
        const [box_color, label] = box_to_color_label(box);
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
  extensionContext.registerMessageConverter({
    fromSchemaName: "edgefirst_msgs/msg/Detect",
    toSchemaName: "foxglove.SceneUpdate",
    converter: (inputMessage: DetectBoxes2D): SceneUpdate => {
      const texts: TextPrimitive[] = [];
      const lines: LinePrimitive[] = [];
      inputMessage.boxes.forEach((b: DetectBox2D) => {
        if (b.distance === 0) {
          return;
        }
        const x = b.distance;
        const y = b.center_x;
        const z = b.center_y;

        const width = b.width;
        const height = b.height;
        const [box_color, label] = box_to_color_label(b);
        const line: LinePrimitive = {
          type: LineType.LINE_LIST,
          pose: {
            position: {
              x,
              y,
              z,
            },
            orientation: {
              x: 0,
              y: 0,
              z: 0,
              w: 1,
            },
          },
          thickness: 2,
          scale_invariant: true,
          points: [
            { x: -width / 2, y: -width / 2, z: -height / 2 },
            { x: -width / 2, y: +width / 2, z: -height / 2 },
            { x: -width / 2, y: +width / 2, z: +height / 2 },
            { x: -width / 2, y: -width / 2, z: +height / 2 },
            { x: +width / 2, y: -width / 2, z: -height / 2 },
            { x: +width / 2, y: +width / 2, z: -height / 2 },
            { x: +width / 2, y: +width / 2, z: +height / 2 },
            { x: +width / 2, y: -width / 2, z: +height / 2 },
          ],
          color: box_color,
          colors: [],
          indices: [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7],
        };
        lines.push(line);

        const t: TextPrimitive = {
          pose: {
            position: {
              x,
              y,
              z: z + height / 2 + 0.2,
            },
            orientation: {
              x: 0,
              y: 0,
              z: 0,
              w: 1,
            },
          },
          billboard: true,
          font_size: 12,
          scale_invariant: true,
          color: box_color,
          text: label,
        };
        texts.push(t);
      });

      const new_annot: SceneEntity = {
        timestamp: inputMessage.inputTimestamp,
        frame_id: inputMessage.header.frame_id,
        id: inputMessage.header.frame_id,
        lifetime: {
          sec: 0,
          nsec: 0,
        },
        frame_locked: false,
        metadata: [],
        arrows: [],
        cubes: [],
        spheres: [],
        cylinders: [],
        lines,
        triangles: [],
        texts,
        models: [],
      };
      const update: SceneUpdate = {
        deletions: [],
        entities: [new_annot],
      };
      return update;
    },
  });
}

let zstd_loaded = false;
zstd
  .loadWASM()
  .then(() => {
    zstd_loaded = true;
  })
  .catch(() => {
    console.log("Could not load zstd");
  });
function registerMaskConverter(extensionContext: ExtensionContext): void {
  extensionContext.registerMessageConverter({
    fromSchemaName: "edgefirst_msgs/msg/Mask",
    toSchemaName: "foxglove_msgs/msg/RawImage",
    converter: (inputMessage: Mask): RawImage => {
      const data = new Uint8Array(inputMessage.height * inputMessage.width * 4);
      const rawImage: RawImage = {
        timestamp: { sec: 0, nsec: 0 },
        frame_id: "",
        width: inputMessage.width,
        height: inputMessage.height,
        encoding: "rgba8",
        step: 4 * inputMessage.width,
        data,
      };

      let mask = inputMessage.mask;
      if (inputMessage.encoding === "zstd") {
        if (zstd_loaded) {
          mask = zstd.decompress(inputMessage.mask);
        } else {
          return rawImage;
        }
      }
      const classes: number = Math.round(mask.length / inputMessage.height / inputMessage.width);
      for (let i = 0; i < inputMessage.height * inputMessage.width; i++) {
        // let row_stride = inputMessage.width * classes;
        // let col_stride = classes;
        // let scores = []
        let max_ind = 0;
        let max_val = 0;
        for (let j = 0; j < classes; j++) {
          const val = mask.at(i * classes + j) ?? 0;
          if (val > max_val) {
            max_ind = j;
            max_val = val;
          }
        }
        const color = CLASS_COLORS_I8[max_ind] ?? WHITE_I8;
        data[i * 4 + 0] = (color.r * max_val) / 255.0;
        data[i * 4 + 1] = (color.g * max_val) / 255.0;
        data[i * 4 + 2] = (color.b * max_val) / 255.0;
        data[i * 4 + 3] = color.a;
      }

      return rawImage;
    },
  });

  extensionContext.registerMessageConverter({
    fromSchemaName: "edgefirst_msgs/msg/Mask",
    toSchemaName: "foxglove_msgs/msg/ImageAnnotations",
    converter: (inputMessage: Mask): ImageAnnotations => {
      const new_annot: ImageAnnotations = {
        circles: [],
        points: [],
        texts: [],
      };

      let mask = inputMessage.mask;
      if (inputMessage.encoding === "zstd") {
        if (zstd_loaded) {
          mask = zstd.decompress(inputMessage.mask);
        } else {
          return new_annot;
        }
      }
      const classes: number = Math.round(mask.length / inputMessage.height / inputMessage.width);
      const data = [];
      for (let i = 0; i < classes; i++) {
        data.push(new Uint8Array(inputMessage.height * inputMessage.width));
      }
      for (let i = 0; i < inputMessage.height * inputMessage.width; i++) {
        // let row_stride = inputMessage.width * classes;
        // let col_stride = classes;
        // let scores = []
        let max_ind = 0;
        let max_val = 0;
        for (let j = 0; j < classes; j++) {
          const val = mask.at(i * classes + j) ?? 0;
          if (val > max_val) {
            max_ind = j;
            max_val = val;
          }
        }
        const array = data.at(max_ind);
        if (array) {
          array[i] = 255;
        }
      }
      // ignore the background class
      for (let i = 1; i < classes; i++) {
        const d = data.at(i);
        if (!d) {
          break;
        }
        const img = CV.matFromArray(inputMessage.height, inputMessage.width, CV.CV_8UC1, d);
        const contours = new CV.MatVector();
        const hierarchy = new CV.Mat();
        CV.findContours(img, contours, hierarchy, CV.RETR_CCOMP, CV.CHAIN_APPROX_SIMPLE);

        for (let j = 0; j < contours.size(); j++) {
          const tmp = contours.get(j);
          const points_cnt = tmp.data32S;
          const points_annot = [];
          // The video is assumed to be 1920x1080 dimensions for this converter
          for (let k = 0; k < points_cnt.length / 2; k++) {
            const p: Point2 = {
              x: (((points_cnt[k * 2] ?? 0) + 0.5) / inputMessage.width) * 1920,
              y: (((points_cnt[k * 2 + 1] ?? 0) + 0.5) / inputMessage.height) * 1080,
            };
            points_annot.push(p);
          }

          // CV.contor

          const p: PointsAnnotation = {
            timestamp: { sec: 0, nsec: 0 },
            type: PointsAnnotationType.LINE_LOOP,
            points: points_annot,
            outline_color: CLASS_COLORS_F[i] ?? WHITE,
            outline_colors: [],
            fill_color: CLASS_COLORS_F[i] ?? WHITE,
            thickness: 3,
          };
          new_annot.points.push(p);
          tmp.delete();
        }
        contours.delete();
        hierarchy.delete();
        img.delete();
      }
      // CV.findContours()

      // ensure all annotation messages have a timestamp
      const p: PointsAnnotation = {
        timestamp: { sec: 0, nsec: 0 },
        type: PointsAnnotationType.LINE_LOOP,
        points: [{ x: 0, y: 0 }],
        outline_color: TRANSPARENT,
        outline_colors: [],
        fill_color: TRANSPARENT,
        thickness: 5,
      };
      new_annot.points.push(p);
      return new_annot;
    },
  });
}
const REVERSE_HEIGHT = true;

function registerRadarCubeConverter(extensionContext: ExtensionContext): void {
  extensionContext.registerMessageConverter({
    fromSchemaName: "edgefirst_msgs/msg/RadarCube",
    toSchemaName: "foxglove_msgs/msg/RawImage",
    converter: (inputMessage: RadarCube): RawImage => {
      const height = inputMessage.shape[1] ?? 1;
      const width = inputMessage.shape[3] ?? 1;
      const stride = (inputMessage.shape[2] ?? 1) * width;
      const data = new Uint8Array(width * height * 2);

      const rawImage: RawImage = {
        timestamp: inputMessage.header.timestamp,
        frame_id: inputMessage.header.frame_id,
        width,
        height,
        encoding: "mono16",
        step: 2 * width,
        data,
      };
      let offset = 0;
      if (radarcube_sequence === "A") {
        offset = 0;
      } else if (radarcube_sequence === "B" || radarcube_sequence === "") {
        offset = (inputMessage.shape[0] ?? 1) > 1 ? height * stride : 0;
      } else {
        return rawImage;
      }

      if (radarcube_rx < 0) {
        return rawImage;
      }
      if (radarcube_rx >= (inputMessage.shape[2] ?? 1)) {
        return rawImage;
      }

      offset += width * radarcube_rx;

      const factor = 65535 / 2500;
      for (let i = 0; i < width * height; i++) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        const curr_height = REVERSE_HEIGHT ? height - Math.floor(i / width) : Math.floor(i / width);
        const cube_index = offset + curr_height * stride + (i % width);
        let val = Math.log2(Math.abs(inputMessage.cube[cube_index] ?? 0) + 1) * factor;
        val = Math.min(val, 65535);
        data[i * 2 + 0] = val >> 8;
        data[i * 2 + 1] = val % 256;
      }

      return rawImage;
    },
  });
}

export function activate(extensionContext: ExtensionContext): void {
  registerGlobalVariableGetter(extensionContext);
  registerDetectConverter(extensionContext);
  registerMaskConverter(extensionContext);
  registerRadarCubeConverter(extensionContext);
}
