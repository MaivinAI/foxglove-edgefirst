import {
  ImageAnnotations,
  PointsAnnotation,
  TextAnnotation,
  PointsAnnotationType,
  RawImage,
  Color,
} from "@foxglove/schemas";
import { Time } from "@foxglove/schemas/schemas/typescript/Time";
import { ExtensionContext } from "@foxglove/studio";
import zstd from 'zstandard-wasm';
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
}

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

function registerDetectConverter(extensionContext: ExtensionContext):void {
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

let zstd_loaded = false
zstd.loadWASM().then(() => { zstd_loaded = true })
function registerMaskConverter(extensionContext: ExtensionContext): void {
    extensionContext.registerMessageConverter({
        fromSchemaName: "edgefirst_msgs/msg/Mask",
        toSchemaName: "foxglove_msgs/msg/RawImage",
        converter: (inputMessage: Mask): RawImage => {
            const data = new Uint8Array(inputMessage.height * inputMessage.width * 4)
            const rawImage: RawImage = {
                timestamp: { sec: 0, nsec: 0 },
                frame_id: "",
                width: inputMessage.width,
                height: inputMessage.height,
                encoding: "rgba8",
                step: 4 * inputMessage.width,
                data: data
            }

            let mask = inputMessage.mask;
            if (inputMessage.encoding == "zstd") {
                if (zstd_loaded) {
                    mask = zstd.decompress(inputMessage.mask)
                } else {
                    return rawImage
                }
            }
            const classes:number = Math.round(mask.length / inputMessage.height / inputMessage.width)            
            for (let i = 0; i < inputMessage.height * inputMessage.width; i++) {
                // let row_stride = inputMessage.width * classes;
                // let col_stride = classes;
                // let scores = []
                let max_ind = 0
                let max_val = 0
                for(let j = 0; j < classes; j++) {
                    let val = mask.at(i * classes + j) ?? 0
                    if (val > max_val) {
                        max_ind = j
                        max_val = val
                    }
                }
                switch (max_ind) {
                    case 1:
                        data[i * 4 + 0] = 255
                        data[i * 4 + 1] = 0
                        data[i * 4 + 2] = 0
                        data[i * 4 + 3] = 255
                        break
                    case 2:
                        data[i * 4 + 0] = 0
                        data[i * 4 + 1] = 255
                        data[i * 4 + 2] = 0
                        data[i * 4 + 3] = 255
                        break
                    case 3:
                        data[i * 4 + 0] = 0
                        data[i * 4 + 1] = 0
                        data[i * 4 + 2] = 255
                        data[i * 4 + 3] = 255
                        break
                    default:
                        data[i * 4 + 0] = 0
                        data[i * 4 + 1] = 0
                        data[i * 4 + 2] = 0
                        data[i * 4 + 3] = 0
                        break    
                }
                
            }



            return rawImage
        },
    });
}

export function activate(extensionContext: ExtensionContext): void {
    registerDetectConverter(extensionContext)
    registerMaskConverter(extensionContext)
}
