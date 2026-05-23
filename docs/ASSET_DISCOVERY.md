# Asset Discovery

OpenReelio uses an English-first asset discovery surface for agent workflows. External provider search returns candidate references and policy metadata first; import and timeline placement are separate approval-gated actions.

## Implemented Foundation

- `search_stock_media` searches configured stock providers through backend adapters.
- `find_assets_for_script` is the agent-facing high-level wrapper for scene/script-based discovery.
- `search_sound_for_scene` is the agent-facing high-level wrapper for SFX and ambient audio discovery.
- `import_asset_candidate` imports an approved candidate through `import_stock_media_asset` with a license snapshot.
- Openverse image/audio search works without a user API key and is the built-in zero-config fallback.
- Pexels and Pixabay visual search require configured API keys.
- Freesound audio search requires a configured API key.
- `import_stock_media_asset` downloads a selected HTTPS candidate into `.openreelio/imports/stock`, writes a license snapshot under `.openreelio/licenses`, and imports the local file through the command log.
- Each candidate includes normalized `LicenseInfo` plus a `LicensePolicyDecision`.
- Pixabay content is treated as provider-restricted royalty-free stock content, not CC0.

## Credential Sources

Provider credentials can be stored through the credential vault with these provider names:

- `pexels`
- `pixabay`
- `freesound`

Environment variable fallbacks are also supported:

- `OPENREELIO_PEXELS_API_KEY` or `PEXELS_API_KEY`
- `OPENREELIO_PIXABAY_API_KEY` or `PIXABAY_API_KEY`
- `OPENREELIO_FREESOUND_API_KEY` or `FREESOUND_API_KEY`

## License Enforcement Model

Every external candidate should flow through this chain:

```txt
provider result
  -> normalized LicenseInfo
  -> LicensePolicyDecision
  -> import_asset_candidate/import_stock_media_asset preflight
  -> timeline placement preflight
  -> export/QC manifest preflight
```

The current implementation covers provider search, normalized policy decisions, and explicit import with license snapshots. `import_stock_media_asset` enforces the download/import preflight for selected candidates by requiring `licenseAck`, rejecting blocked policies, and persisting the license snapshot before the asset is registered. Timeline placement still must reject unsafe external candidates and export/QC should continue checking attribution and provider terms.

## Local Search Status

The indexing database contains tables such as `shots`, `transcripts`, and `embeddings`, but an embeddings table is not a semantic search implementation by itself. Full local semantic search still needs:

- query embedding generation,
- vector decoding and model/version filtering,
- distance scoring or ANN retrieval,
- score calibration against lexical/FTS matches,
- reindexing when models or source analysis changes,
- fallback behavior when embeddings are missing or stale.

Until those pieces exist, local discovery should be described as lexical/FTS and analysis-report retrieval, not embedding-backed semantic search.

## Deferred Work

- Add a candidate-id based import flow so callers do not need to pass candidate metadata back manually.
- Add timeline placement preflight that blocks unsafe external candidates.
- Add export/QC manifest checks for attribution and provider terms.
- Add TTL metadata cache for provider results.
- Add local candidate search over shot/transcript/OCR segments.
- Add embedding rerank only after the retrieval contract above is implemented.
- Add no-key video providers or a hosted broker/plugin path for turnkey stock video search.
