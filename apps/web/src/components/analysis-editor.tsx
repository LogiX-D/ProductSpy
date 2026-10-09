'use client';

import { Plus, Trash2 } from 'lucide-react';
import { analysisCopy } from './analysis-copy';
import { scriptKeys, type AnalysisDraft, type AnalysisListField } from './analysis-utils';
import { Button } from './ui';

function ListEditor({
  field,
  values,
  onChange,
}: {
  field: AnalysisListField;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const label = analysisCopy[field];
  return (
    <div className="analysis-list-editor">
      <div className="analysis-subheading">
        <h3>{label}</h3>
        <span className="analysis-item-count">{values.length} / 30</span>
      </div>
      <p className="analysis-field-hint">
        {field === 'hooks' ? analysisCopy.hooksHint : analysisCopy.listHint}
      </p>
      {values.map((value, index) => (
        <div className="analysis-editor-item" key={index}>
          <label htmlFor={`analysis-edit-${field}-${index}`}>
            {label} {index + 1}
          </label>
          <textarea
            id={`analysis-edit-${field}-${index}`}
            value={value}
            maxLength={12000}
            rows={field === 'imagePrompts' || field === 'videoPrompts' ? 4 : 2}
            onChange={(event) =>
              onChange(
                values.map((item, position) => (position === index ? event.target.value : item)),
              )
            }
          />
          <Button
            variant="ghost"
            className="analysis-remove-item"
            aria-label={`${analysisCopy.removeItem} ${label} ${index + 1}`}
            onClick={() => onChange(values.filter((_, position) => position !== index))}
          >
            <Trash2 size={14} />
            {analysisCopy.removeItem}
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        onClick={() => onChange([...values, ''])}
        disabled={values.length >= 30}
      >
        <Plus size={14} />
        {analysisCopy.addItem}
      </Button>
    </div>
  );
}

export function AnalysisEditor({
  draft,
  onChange,
  disabled,
}: {
  draft: AnalysisDraft;
  onChange: (draft: AnalysisDraft) => void;
  disabled: boolean;
}) {
  const list = (field: AnalysisListField) => (
    <ListEditor
      key={field}
      field={field}
      values={draft[field]}
      onChange={(values) => onChange({ ...draft, [field]: values })}
    />
  );
  return (
    <fieldset className="analysis-editor-fields" disabled={disabled}>
      <legend className="sr-only">{analysisCopy.edit}</legend>
      <div className="analysis-content-grid">
        <section id="analysis-summary" className="analysis-block analysis-block-wide" tabIndex={-1}>
          <h2>{analysisCopy.summary}</h2>
          <label className="sr-only" htmlFor="analysis-edit-summary">
            {analysisCopy.summary}
          </label>
          <textarea
            id="analysis-edit-summary"
            value={draft.summary}
            rows={4}
            maxLength={12000}
            onChange={(event) => onChange({ ...draft, summary: event.target.value })}
          />
        </section>
        <section id="analysis-sellingPoints" className="analysis-block" tabIndex={-1}>
          {list('sellingPoints')}
        </section>
        <section id="analysis-marketingAngles" className="analysis-block" tabIndex={-1}>
          {list('marketingAngles')}
        </section>
        <section id="analysis-audience" className="analysis-block" tabIndex={-1}>
          <h2>{analysisCopy.audience}</h2>
          {list('targetAudience')}
          {list('purchaseMotivations')}
          {list('painPoints')}
        </section>
        <section id="analysis-strengths" className="analysis-block" tabIndex={-1}>
          <h2>{analysisCopy.strengthsSection}</h2>
          {list('strengths')}
          {list('weaknesses')}
        </section>
        <section id="analysis-hooks" className="analysis-block analysis-block-wide" tabIndex={-1}>
          {list('hooks')}
        </section>
        <section
          id="analysis-shortVideoScript"
          className="analysis-block analysis-block-wide"
          tabIndex={-1}
        >
          <h2>{analysisCopy.shortVideoScript}</h2>
          <p className="analysis-field-hint">{analysisCopy.scriptHint}</p>
          <div className="analysis-script-editor">
            {scriptKeys.map((key) => (
              <div className="analysis-editor-item" key={key}>
                <label htmlFor={`analysis-edit-script-${key}`}>
                  {analysisCopy.scriptSteps[key]}
                </label>
                <textarea
                  id={`analysis-edit-script-${key}`}
                  value={draft.shortVideoScript[key]}
                  rows={3}
                  maxLength={12000}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      shortVideoScript: { ...draft.shortVideoScript, [key]: event.target.value },
                    })
                  }
                />
              </div>
            ))}
          </div>
        </section>
        <section id="analysis-imagePrompts" className="analysis-block" tabIndex={-1}>
          {list('imagePrompts')}
        </section>
        <section id="analysis-videoPrompts" className="analysis-block" tabIndex={-1}>
          {list('videoPrompts')}
        </section>
      </div>
    </fieldset>
  );
}
