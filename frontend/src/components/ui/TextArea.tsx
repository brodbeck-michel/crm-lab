import { forwardRef, useId } from 'react';
import type { TextareaHTMLAttributes } from 'react';
import { cn } from './cn';

export interface TextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  label?: string;
  error?: string;
  hint?: string;
}

/** Campo MULTILINHA — `--radius-md`, nunca pílula (DESIGN_TOKENS.md). */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, error, hint, id, rows = 3, disabled, ...rest },
  ref,
) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const describedBy = error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined;

  return (
    <div className="flex w-full flex-col gap-xs">
      {label && (
        <label htmlFor={fieldId} className="font-body text-caption font-semibold text-neutral-700">
          {label}
        </label>
      )}

      <textarea
        {...rest}
        id={fieldId}
        ref={ref}
        rows={rows}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          'w-full resize-none rounded-md border bg-bg px-[14px] py-[10px]',
          'font-body text-label text-text outline-none transition-colors',
          'placeholder:text-neutral-600 focus:border-accent',
          error ? 'border-accent-600' : 'border-neutral-300',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      />

      {error ? (
        <span id={`${fieldId}-error`} role="alert" className="font-body text-caption text-accent-700">
          {error}
        </span>
      ) : hint ? (
        <span id={`${fieldId}-hint`} className="font-body text-caption text-neutral-600">
          {hint}
        </span>
      ) : null}
    </div>
  );
});
