import type { FC, JSX } from "hono/jsx";
import type { IconNode } from "lucide";
import { AtSign, CalendarClock, Check, ChevronLeft, ChevronRight, CircleDot, CircleX, Copy, Ellipsis, Eye, EyeOff, Globe2, Info, KeyRound, Megaphone, Pencil, Plus, Search, Send, Users, X } from "lucide";

type SvgProps = {
  class?: string;
  width?: string | number;
  height?: string | number;
  [key: string]: unknown;
};
type IconProps = SvgProps & { iconNode: IconNode };

export const Icon: FC<IconProps> = ({ iconNode, class: className, ...props }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class={className} aria-hidden="true" {...props}>
    {(iconNode as [string, Record<string, string | number | undefined>][]).map(([tag, attrs], index) => {
      const Tag = tag as keyof JSX.IntrinsicElements;
      return <Tag key={index} {...attrs}/>;
    })}
  </svg>
);

const createIcon = (node: IconNode): FC<SvgProps> => (props) => <Icon iconNode={node} {...props}/>;

export const AddIcon = createIcon(Plus);
export const AudienceIcon = createIcon(Users);
export const BroadcastIcon = createIcon(Megaphone);
export const CalendarIcon = createIcon(CalendarClock);
export const CheckIcon = createIcon(Check);
export const ChevronLeftIcon = createIcon(ChevronLeft);
export const ChevronRightIcon = createIcon(ChevronRight);
export const CloseIcon = createIcon(X);
export const ContactIcon = createIcon(AtSign);
export const CopyIcon = createIcon(Copy);
export const DomainIcon = createIcon(Globe2);
export const DraftIcon = createIcon(CircleDot);
export const EditIcon = createIcon(Pencil);
export const EllipsisIcon = createIcon(Ellipsis);
export const ErrorIcon = createIcon(CircleX);
export const EyeIcon = createIcon(Eye);
export const EyeOffIcon = createIcon(EyeOff);
export const InfoIcon = createIcon(Info);
export const KeyIcon = createIcon(KeyRound);
export const SearchIcon = createIcon(Search);
export const SendIcon = createIcon(Send);
