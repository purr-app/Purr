import type { HttpMethod } from "../../../shared/model/http-method";

export type { HttpMethod } from "../../../shared/model/http-method";

export type RequestDraft = {
  method: HttpMethod;
  url: string;
};

export const initialRequestDraft: RequestDraft = {
  method: "GET",
  url: "https://api.example.com/users/42",
};
