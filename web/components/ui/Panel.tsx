'use client';
import { forwardRef, type HTMLAttributes } from 'react';

// R-2b design system Panel. The warm card-room surface: rounded, brass-tinted
// hairline border, deep surface fill, subtle lifted shadow. Four sites across
// lobby + room all used slight variants of this class string — one component
// prevents the next feature from spawning a 5th. Pass className for layout
// tweaks (padding / grid span etc.); the visual tokens stay owned here.

interface PanelProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section';
}

export const Panel = forwardRef<HTMLElement, PanelProps>(
  ({ as = 'section', className = '', ...rest }, ref) => {
    const Tag = as;
    return (
      <Tag
        // forwardRef typing is fiddly across polymorphic tags — this cast
        // is the pragmatic path; both section and div accept HTMLElement
        // refs at runtime.
        ref={ref as never}
        {...rest}
        className={`rounded-lg border border-amber-900/30 bg-surface/60 shadow-sm ${className}`}
      />
    );
  },
);
Panel.displayName = 'Panel';
