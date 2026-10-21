import configuration from "./operator-configuration.json" with { type: "json" };

export const OPERATOR_CONFIGURATION = configuration;
export type OperatorSettingName = (typeof configuration.settings)[number]["name"];

export function operatorSettingName(name: OperatorSettingName) {
  return name;
}
