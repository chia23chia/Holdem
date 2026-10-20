'use client';
import { useId, type ReactNode } from 'react';
import { useEscape } from '@/lib/useEscape';

// R-2c design system Modal. Centralizes the backdrop + inner-box pattern,
// Esc key dismissal, role=dialog + aria-modal + aria-labelledby. Every
// previous modal duplicated this scaffolding; a one-line typo in any of
// them would silently drop a11y.
//
// `title` is required so there's always an accessible name and a visible
// header. If the caller needs richer header content, pass a ReactNode.
// `size="sm"` for compact confirms (加註 / 封鎖), `md` for form flows
// (建立房間), `lg` for the settlement screen.
//
// The modal body is user-controlled — wrap in <form onSubmit> for Enter
// commit; wrap in <> for plain content.

type Size = 'sm' | 'md' | 'lg';

const sizeClass: Record<Size, string> = {
  sm: 'max-w-xs',
  md: 'max-w-md',
  lg: 'max-w-xl',
};

interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  size?: Size;
  // Click-outside-to-close. Default on; set false for high-stakes
  // confirms where an accidental backdrop tap would be destructive.
  closeOnBackdrop?: boolean;
}

export function Modal({
  title,
  onClose,
  children,
  size = 'md',
  closeOnBackdrop = true,
}: ModalProps) {
  const titleId = useId();
  useEscape(onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`w-full rounded-lg border border-amber-900/30 bg-surface p-6 shadow-xl ${sizeClass[size]}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="mb-4 text-lg font-bold">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
