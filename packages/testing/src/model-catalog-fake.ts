// Structural twin of pomtreed's ModelCatalog / ModelList (testing depends on core only, so it cannot import pomtreed).
export interface FakeModelEntry {
  provider: string;
  id: string;
  label?: string;
  default?: boolean;
}
export interface FakeModelList {
  models: FakeModelEntry[];
  default?: { provider: string; id: string };
  source: "pi" | "none";
  reason?: string;
}

// The model every test daemon resolves when nothing else names one: the default catalog lists only it.
export const TEST_MODEL: Readonly<{ provider: string; id: string }> = Object.freeze({ provider: "test", id: "test-model" });

// Scripts the host model catalog (what `pi --list-models` would list) and counts `list` calls. The default lists TEST_MODEL as
// the default, so a spawn that names no model resolves one and its container start can issue a model key. Pass `[]` for an empty
// catalog (source "none", the real catalog's shape when Pi lists nothing).
export class FakeModelCatalog {
  calls = 0;
  private readonly value: FakeModelList;

  constructor(models: readonly { provider: string; id: string }[] = [TEST_MODEL], defaultModel: { provider: string; id: string } | undefined = models[0]) {
    this.value =
      models.length === 0
        ? { models: [], source: "none", reason: "pi listed no models" }
        : {
            models: models.map((m) => ({
              provider: m.provider,
              id: m.id,
              ...(defaultModel && m.provider === defaultModel.provider && m.id === defaultModel.id && { default: true }),
            })),
            ...(defaultModel && { default: { provider: defaultModel.provider, id: defaultModel.id } }),
            source: "pi",
          };
  }

  async list(): Promise<FakeModelList> {
    this.calls++;
    return structuredClone(this.value);
  }
}
