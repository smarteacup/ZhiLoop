import { loadConfiguration, type ConfigurationDiagnostic } from "./loader.js";
import { DEFAULT_CONFIGURATION, type ZhiLoopConfiguration } from "./policies.js";

export type ConfigurationActivationResult =
  | { readonly activated: true; readonly configuration: ZhiLoopConfiguration }
  | {
      readonly activated: false;
      readonly configuration: ZhiLoopConfiguration;
      readonly error: ConfigurationDiagnostic;
    };

export class ConfigurationStore {
  #active: ZhiLoopConfiguration;

  constructor(initial: string | unknown = DEFAULT_CONFIGURATION) {
    const result = loadConfiguration(initial);
    if (!result.ok) throw new Error(result.error.message);
    this.#active = result.value;
  }

  get active(): ZhiLoopConfiguration {
    return this.#active;
  }

  activate(input: string | unknown): ConfigurationActivationResult {
    const result = loadConfiguration(input);
    if (!result.ok) {
      return { activated: false, configuration: this.#active, error: result.error };
    }

    this.#active = result.value;
    return { activated: true, configuration: this.#active };
  }
}

