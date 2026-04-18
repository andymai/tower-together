import {
	ArrowUpDown,
	Bed,
	BedDouble,
	Briefcase,
	Car,
	ChevronsUpDown,
	Crown,
	DoorOpen,
	Eraser,
	Film,
	Home,
	type LucideIcon,
	MoveUpRight,
	PartyPopper,
	Pizza,
	Recycle,
	Search,
	ShoppingBag,
	Square,
	TramFront,
	UtensilsCrossed,
} from "lucide-react";
import type { SelectedTool } from "../types";
import { TILE_COSTS } from "../types";
import { gameScreenStyles as styles } from "./gameScreenStyles";

interface ToolEntry {
	id: SelectedTool;
	label: string;
	color: string;
	cost: number;
	Icon: LucideIcon;
}

const CATEGORIES: ToolEntry[][] = [
	[
		{
			id: "floor",
			label: "Floor",
			color: "#777",
			cost: TILE_COSTS.floor,
			Icon: Square,
		},
		{
			id: "lobby",
			label: "Lobby",
			color: "#c9a77a",
			cost: TILE_COSTS.lobby,
			Icon: DoorOpen,
		},
		{
			id: "stairs",
			label: "Stairs",
			color: "#e8d5a3",
			cost: TILE_COSTS.stairs,
			Icon: ChevronsUpDown,
		},
		{
			id: "elevator",
			label: "Elevator",
			color: "#a0a0e0",
			cost: TILE_COSTS.elevator,
			Icon: ArrowUpDown,
		},
		{
			id: "escalator",
			label: "Escalator",
			color: "#c0a0d0",
			cost: TILE_COSTS.escalator,
			Icon: MoveUpRight,
		},
	],
	[
		{
			id: "hotelSingle",
			label: "Single",
			color: "#f28b82",
			cost: TILE_COSTS.hotelSingle,
			Icon: Bed,
		},
		{
			id: "hotelTwin",
			label: "Twin",
			color: "#e35d5b",
			cost: TILE_COSTS.hotelTwin,
			Icon: BedDouble,
		},
		{
			id: "hotelSuite",
			label: "Suite",
			color: "#b63c3c",
			cost: TILE_COSTS.hotelSuite,
			Icon: Crown,
		},
	],
	[
		{
			id: "restaurant",
			label: "Restaurant",
			color: "#e58a3a",
			cost: TILE_COSTS.restaurant,
			Icon: UtensilsCrossed,
		},
		{
			id: "fastFood",
			label: "Fast Food",
			color: "#f2b24d",
			cost: TILE_COSTS.fastFood,
			Icon: Pizza,
		},
		{
			id: "retail",
			label: "Retail",
			color: "#a0c040",
			cost: TILE_COSTS.retail,
			Icon: ShoppingBag,
		},
	],
	[
		{
			id: "office",
			label: "Office",
			color: "#a8b7c4",
			cost: TILE_COSTS.office,
			Icon: Briefcase,
		},
		{
			id: "condo",
			label: "Condo",
			color: "#e7cf6b",
			cost: TILE_COSTS.condo,
			Icon: Home,
		},
	],
	[
		{
			id: "cinema",
			label: "Cinema",
			color: "#c040a0",
			cost: TILE_COSTS.cinema,
			Icon: Film,
		},
		{
			id: "partyHall",
			label: "Party Hall",
			color: "#d96fb8",
			cost: TILE_COSTS.partyHall,
			Icon: PartyPopper,
		},
	],
	[
		{
			id: "recyclingCenter",
			label: "Recycling",
			color: "#c04040",
			cost: TILE_COSTS.recyclingCenter,
			Icon: Recycle,
		},
		{
			id: "parking",
			label: "Parking",
			color: "#8fa0b0",
			cost: TILE_COSTS.parking,
			Icon: Car,
		},
		{
			id: "metro",
			label: "Metro",
			color: "#60c0c0",
			cost: TILE_COSTS.metro,
			Icon: TramFront,
		},
	],
	[
		{ id: "empty", label: "Erase", color: "#888", cost: 0, Icon: Eraser },
		{
			id: "inspect",
			label: "Inspect",
			color: "#5bc0de",
			cost: 0,
			Icon: Search,
		},
	],
];

interface Props {
	selectedTool: SelectedTool;
	onToolSelect: (tool: SelectedTool) => void;
}

export function GameBuildPanel({ selectedTool, onToolSelect }: Props) {
	return (
		<div style={styles.buildPanel}>
			<div style={styles.debugTitle}>Build</div>
			{CATEGORIES.map((tools, categoryIndex) => (
				<div
					key={tools[0].id}
					style={{
						...styles.buildGrid,
						...(categoryIndex > 0 ? { marginTop: 2 } : {}),
					}}
				>
					{tools.map((tool) => {
						const active = selectedTool === tool.id;
						return (
							<button
								key={tool.id}
								type="button"
								title={
									tool.cost > 0
										? `${tool.label} — $${tool.cost.toLocaleString()}`
										: tool.label
								}
								style={{
									...styles.buildBtn,
									borderColor: active
										? tool.color
										: "rgba(123, 148, 170, 0.25)",
									background: active
										? `${tool.color}22`
										: "rgba(255, 255, 255, 0.02)",
									color: active ? tool.color : "#aab8c2",
								}}
								onClick={() => onToolSelect(tool.id)}
							>
								<tool.Icon size={16} strokeWidth={1.8} />
								<span style={styles.buildBtnLabel}>{tool.label}</span>
							</button>
						);
					})}
				</div>
			))}
		</div>
	);
}
