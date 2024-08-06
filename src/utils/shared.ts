import ms from "ms";
import { Context, Label } from "../types";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export function calculateDurations(labels: Label[]): number[] {
  // from shortest to longest
  const durations: number[] = [];

  labels.forEach((label: Label) => {
    const matches = label.name.match(/<(\d+)\s*(\w+)/);
    if (matches && matches.length >= 3) {
      const number = parseInt(matches[1]);
      const unit = matches[2];
      const duration = ms(`${number} ${unit}`) / 1000;
      durations.push(duration);
    }
  });

  return durations.sort((a, b) => a - b);
}

export function getAppId(context: Context): number {
  const {
    env: { APP_ID },
  } = context;
  const APP_ID_TYPE = Type.Union([Type.String(), Type.Number()], { default: APP_ID });

  const val = Type.Transform(APP_ID_TYPE)
    .Decode((val) => {
      if (isNaN(Number(val))) {
        throw new Error("Invalid APP_ID");
      }
      return Number(val);
    })
    .Encode((encoded) => encoded.toString());

  try {
    return Value.Decode(val, APP_ID);
  } catch (e) {
    throw new Error("Invalid APP_ID");
  }
}
