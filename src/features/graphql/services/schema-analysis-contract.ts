export type GraphqlSchemaAnalysisProfile = {
  sourceBytes: number;
  normalizedSdlBytes: number;
  durationMs: number;
};

export type GraphqlSchemaAnalysisRequest = {
  kind: "normalize-schema";
  requestId: number;
  source: string;
};

export type GraphqlSchemaAnalysisResponse =
  | {
      kind: "schema-normalized";
      requestId: number;
      normalizedSdl: string;
      profile: GraphqlSchemaAnalysisProfile;
    }
  | {
      kind: "schema-analysis-error";
      requestId: number;
      message: string;
    };

