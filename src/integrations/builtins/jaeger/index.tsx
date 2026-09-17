import { defineExtensionModule, type IntegrationSettingsProps } from "../../../extension-api";
import { IntegrationConnectionSettings } from "../../../extension-api/ui";
import icon from "./jaeger-logo.svg";

function JaegerSettings(props: IntegrationSettingsProps) {
  return <IntegrationConnectionSettings {...props} />;
}
export const jaegerModule = defineExtensionModule({
  manifest: { id: "purr.jaeger", version: "1.0.0", extensionApi: 1 },
  register(registrar) {
    registrar.integrations.register({
      id: "jaeger", label: "Jaeger", icon,
      description: "Explore distributed traces, service timings and span attributes.",
      capabilities: ["traces"],
      initialConfig: { endpoint: "http://127.0.0.1:16686", auth: "none" },
      credentialKeys: ["apiToken", "auth"], Settings: JaegerSettings,
    });
  },
});
