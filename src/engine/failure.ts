/**
 * How a use of a feature fails where the feature is missing. Severity follows from the
 * failure mode, which the language adapters derive from syntax alone. No per-feature
 * curation is involved, so it applies the same way to every codebase.
 */
export type FailureMode =
  /** JS: calling a missing method, constructing or referencing a missing global. */
  | 'throws'
  /** CSS: an unknown selector in a list invalidates every selector in that list. */
  | 'rule-list-dropped'
  /** CSS: a rule with one selector (or a nested rule) is dropped. */
  | 'rule-ignored'
  /** CSS: an at-rule, media feature or query syntax the browser can't parse; the block never applies. */
  | 'block-ignored'
  /** JS: reading a missing property yields `undefined`. */
  | 'undefined-value'
  /** JS: assigning to a missing property has no effect. */
  | 'no-op'
  /** CSS: an unknown property or value drops the declaration; the earlier or inherited value applies. */
  | 'declaration-ignored'
  /** HTML: an unknown element renders as a plain inline element; its contents still show. */
  | 'element-unknown'
  /** HTML: an unknown attribute or attribute value is ignored; the default behaviour applies. */
  | 'attribute-ignored'
  /** Supported, but partially; behaviour differs as described in the notes. */
  | 'differs';

export type Severity = 'error' | 'warning' | 'info';

export const FAILURE: Record<FailureMode, { severity: Severity; summary: string }> = {
  throws: { severity: 'error', summary: 'throws an error where unsupported' },
  'rule-list-dropped': {
    severity: 'error',
    summary: 'the whole rule is dropped where unsupported, including the other selectors in its list',
  },
  'rule-ignored': { severity: 'warning', summary: 'the rule is dropped where unsupported' },
  'block-ignored': { severity: 'warning', summary: 'the block never applies where unsupported' },
  'undefined-value': { severity: 'warning', summary: 'reads return undefined where unsupported' },
  'no-op': { severity: 'warning', summary: 'the assignment has no effect where unsupported' },
  'declaration-ignored': {
    severity: 'info',
    summary: 'the declaration is ignored where unsupported, so the earlier or inherited value applies',
  },
  'element-unknown': {
    severity: 'warning',
    summary: 'the element is unknown where unsupported, so it renders as a plain inline element and its contents always show',
  },
  'attribute-ignored': { severity: 'info', summary: 'the attribute or value is ignored where unsupported, so the default behaviour applies' },
  differs: { severity: 'info', summary: 'supported, but behaves differently (see notes)' },
};

export const SEVERITY_RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 };
