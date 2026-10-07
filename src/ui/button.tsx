import type { FC, JSX } from "hono/jsx";
import { cn } from "./utils";

export const buttonVariants = {
  variant: {
    default: "primary",
    outline: "",
    ghost: "ghost",
    destructive: "danger",
  },
  size: {
    default: "",
    sm: "small-button",
    icon: "icon-button",
  },
} as const;

type ButtonProps = JSX.IntrinsicElements["button"] & {
  variant?: keyof typeof buttonVariants.variant;
  size?: keyof typeof buttonVariants.size;
};

export const Button: FC<ButtonProps> = ({ variant = "outline", size = "default", class: className, children, ...props }) => (
  <button data-slot="button" class={cn(buttonVariants.variant[variant], buttonVariants.size[size], className)} {...props}>{children}</button>
);
