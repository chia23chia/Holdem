'use client';
import { forwardRef, type ButtonHTMLAttributes } from 'react';

// R-2a design system Button. Replaces hand-crafted class strings scattered
// across the app. Four semantic variants + two sizes cover all current
// button patterns. New variants should prefer composition over expanding
// this enum — if a one-off style is needed, keep it inline.
//
// Variants:
//   primary  — hero (brass). The committed-action button. Max 1 per screen.
//   secondary — accepting default action (felt green). "過牌 / 跟注 / 確定".
//   ghost    — low-prominence (transparent border + bone/70). "取消 / 棄牌".
//   danger   — destructive confirm (red). "確定關閉房間 / 封鎖".

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'md' | 'sm';

const base =
  'inline-flex items-center justify-center rounded font-semibold transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

const variantClass: Record<Variant, string> = {
  primary: 'bg-brass text-rail shadow-lg hover:bg-brass/90 font-bold',
  secondary: 'bg-felt text-bone hover:bg-felt/80',
  ghost: 'border border-bone/20 bg-transparent text-bone/70 hover:bg-white/5',
  danger: 'bg-red-700 text-bone hover:bg-red-600',
};

const sizeClass: Record<Size, string> = {
  md: 'min-h-[44px] px-4 py-2.5 text-base',
  sm: 'px-3 py-1.5 text-sm',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant = 'secondary', size = 'md', className = '', ...rest },
    ref,
  ) => (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      {...rest}
      className={`${base} ${variantClass[variant]} ${sizeClass[size]} ${className}`}
    />
  ),
);
Button.displayName = 'Button';
