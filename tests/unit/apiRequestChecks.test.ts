import { describe, expect, it } from "vitest";
import * as parameters from "@constructorfleet/sketchforge-engine/apiParameters";
import * as constraints from "@constructorfleet/sketchforge-engine/apiSketchConstraints";
import * as errors from "@constructorfleet/sketchforge-engine/apiErrors";
import { API_QUERY_VALUE_CORPUS, API_REQUEST_BODY_CORPUS, readings, verdicts } from "./support/apiRequestCorpus";

/** Verdicts recorded from the hand-written checks before the request definitions replaced them. */
const BODY_VERDICTS = {
  createParameter: "00000000000000000000111000000011010000000000000000000000000000000000000000000000000000000000000000000000000",
  changeParameter: "00000000101100000000000000000000000000001000000101001000000000000000000000000000000000000000000000000000000",
  createConfiguration: "00000000101111000000000000000000000000000000000000000000000000001110000100111000000001000000000000000000000",
  changeConfiguration: "00000000101111000000000000000000000000000000000000000000000000000000000000000000000000001100001000110000000",
  activateConfiguration: "00000000101111001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  bindSketchConstraint: "00000000000000000000000000000000000000001001000100000000000000000000000000000000000000000000000000000000000",
};

const QUERY_READINGS = {
  parameterName: ["-","-","-","-","-","-","-","\"wall\"","\"wall\"","\"wall\"","\"my-project_1\"","\"my-project_1\"","\"-project\"","\"_project\"","\"project.one\"","\"project one\"","\"Ünïcode\"","length 64","length 64","-","-","-","-","-","-","-","-","-","-"],
  configurationName: ["-","-","-","-","-","\" \"","\"\\t\"","\"wall\"","\" wall \"","\"\\twall\\n\"","\"my-project_1\"","\" my-project_1 \"","\"-project\"","\"_project\"","\"project.one\"","\"project one\"","\"Ünïcode\"","length 64","length 66","length 65","length 100","length 100","-","-","-","-","-","-","-"],
  constraintId: ["-","-","-","-","-","-","-","\"wall\"","\"wall\"","\"wall\"","\"my-project_1\"","\"my-project_1\"","\"-project\"","\"_project\"","\"project.one\"","\"project one\"","\"Ünïcode\"","length 64","length 64","length 65","length 100","length 99","length 101","length 120","length 120","length 121","length 200","length 200","-"],
  projectId: ["-","-","-","-","-","-","-","\"wall\"","\"wall\"","\"wall\"","\"my-project_1\"","\"my-project_1\"","-","-","-","-","-","length 64","length 64","length 65","length 100","length 99","length 101","length 120","length 120","-","-","-","-"],
  shapeId: ["-","-","-","-","-","-","-","\"wall\"","\"wall\"","\"wall\"","\"my-project_1\"","\"my-project_1\"","\"-project\"","\"_project\"","\"project.one\"","\"project one\"","\"Ünïcode\"","length 64","length 64","length 65","length 100","length 99","length 101","length 120","length 120","length 121","length 200","length 200","length 201"],
};

describe("engine request checks", () => {
  it("refuse and accept the recorded bodies", () => {
    expect({
      createParameter: verdicts(API_REQUEST_BODY_CORPUS, parameters.isApiParameterCreateRequest),
      changeParameter: verdicts(API_REQUEST_BODY_CORPUS, parameters.isApiParameterChangeRequest),
      createConfiguration: verdicts(API_REQUEST_BODY_CORPUS, parameters.isApiConfigurationCreateRequest),
      changeConfiguration: verdicts(API_REQUEST_BODY_CORPUS, parameters.isApiConfigurationChangeRequest),
      activateConfiguration: verdicts(API_REQUEST_BODY_CORPUS, parameters.isApiConfigurationActivateRequest),
      bindSketchConstraint: verdicts(API_REQUEST_BODY_CORPUS, constraints.isApiSketchConstraintBindRequest),
    }).toEqual(BODY_VERDICTS);
  });

  it("read the recorded query values", () => {
    expect({
      parameterName: readings(API_QUERY_VALUE_CORPUS, parameters.apiParameterName),
      configurationName: readings(API_QUERY_VALUE_CORPUS, parameters.apiConfigurationName),
      constraintId: readings(API_QUERY_VALUE_CORPUS, constraints.apiConstraintId),
      projectId: readings(API_QUERY_VALUE_CORPUS, errors.apiProjectId),
      shapeId: readings(API_QUERY_VALUE_CORPUS, errors.apiShapeId),
    }).toEqual(QUERY_READINGS);
  });
});
