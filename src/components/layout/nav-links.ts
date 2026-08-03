import type { LucideIcon } from "lucide-react";
import { LayoutDashboard, Map } from "lucide-react";

export interface NavLink {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const navLinks: NavLink[] = [
  { href: "/dashboard", label: "לוח בקרה", icon: LayoutDashboard },
  { href: "/map", label: "מפה", icon: Map },
];
