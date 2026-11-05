import { type EgressAuditRecord, sealAuditChain } from "@pomtree/sandbox-docker";
import { FakeEgressAuditReader } from "@pomtree/testing";

// The scripted reader with the writer's hash chain filled in: records go in without a chain (any `chain` they carry is
// replaced), and come out chained from the sandbox's genesis in the order given, exactly as FileEgressAuditWriter would write
// them. Tests that need a broken chain edit a record after sealing or script the rows directly.
export class ChainedEgressAuditReader extends FakeEgressAuditReader<EgressAuditRecord> {
  private readonly bare = new Map<string, Omit<EgressAuditRecord, "chain">[]>();
  override setRecords(sandbox: string, records: (Omit<EgressAuditRecord, "chain"> & { chain?: string })[]): void {
    this.bare.set(
      sandbox,
      records.map(({ chain: _chain, ...rest }) => rest as Omit<EgressAuditRecord, "chain">),
    );
    super.setRecords(sandbox, sealAuditChain(sandbox, this.bare.get(sandbox)!));
  }
  override append(sandbox: string, record: Omit<EgressAuditRecord, "chain"> & { chain?: string }): void {
    this.setRecords(sandbox, [...(this.bare.get(sandbox) ?? []), record]);
  }
}
