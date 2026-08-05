// Hand-written to match supabase/migrations/0001_init.sql. Once the
// Supabase project is linked via the CLI, this can be regenerated with:
//   npx supabase gen types typescript --project-id <ref> --schema public
export type Status = "visited" | "planned" | "not_visited";
export type PlaceKind = "hotel" | "restaurant" | "attraction";
export type PlaceSource = "manual" | "google_places";

export interface Database {
  public: {
    Tables: {
      countries: {
        Row: {
          id: string;
          user_id: string | null;
          name: string;
          iso_a2: string;
          iso_a3: string | null;
          status: Status;
          overview: string | null;
          notes: string | null;
          favorite_memory: string | null;
          rating: number | null;
          latitude: number | null;
          longitude: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Pick<
            Database["public"]["Tables"]["countries"]["Row"],
            | "id"
            | "user_id"
            | "status"
            | "iso_a3"
            | "overview"
            | "notes"
            | "favorite_memory"
            | "rating"
            | "latitude"
            | "longitude"
            | "created_at"
            | "updated_at"
          >
        > &
          Pick<Database["public"]["Tables"]["countries"]["Row"], "name" | "iso_a2">;
        Update: Partial<Database["public"]["Tables"]["countries"]["Insert"]>;
        Relationships: [];
      };
      cities: {
        Row: {
          id: string;
          user_id: string | null;
          country_id: string;
          name: string;
          status: Status;
          latitude: number | null;
          longitude: number | null;
          overview: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Pick<
            Database["public"]["Tables"]["cities"]["Row"],
            | "id"
            | "user_id"
            | "status"
            | "latitude"
            | "longitude"
            | "overview"
            | "notes"
            | "created_at"
            | "updated_at"
          >
        > &
          Pick<Database["public"]["Tables"]["cities"]["Row"], "country_id" | "name">;
        Update: Partial<Database["public"]["Tables"]["cities"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "cities_country_id_fkey";
            columns: ["country_id"];
            isOneToOne: false;
            referencedRelation: "countries";
            referencedColumns: ["id"];
          },
        ];
      };
      trips: {
        Row: {
          id: string;
          user_id: string | null;
          name: string;
          start_date: string | null;
          end_date: string | null;
          budget: number | null;
          cost: number | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Pick<
            Database["public"]["Tables"]["trips"]["Row"],
            | "id"
            | "user_id"
            | "start_date"
            | "end_date"
            | "budget"
            | "cost"
            | "notes"
            | "created_at"
            | "updated_at"
          >
        > &
          Pick<Database["public"]["Tables"]["trips"]["Row"], "name">;
        Update: Partial<Database["public"]["Tables"]["trips"]["Insert"]>;
        Relationships: [];
      };
      trip_cities: {
        Row: {
          id: string;
          trip_id: string;
          city_id: string;
          arrival_date: string | null;
          departure_date: string | null;
          notes: string | null;
          created_at: string;
        };
        Insert: Partial<
          Pick<
            Database["public"]["Tables"]["trip_cities"]["Row"],
            "id" | "arrival_date" | "departure_date" | "notes" | "created_at"
          >
        > &
          Pick<Database["public"]["Tables"]["trip_cities"]["Row"], "trip_id" | "city_id">;
        Update: Partial<Database["public"]["Tables"]["trip_cities"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "trip_cities_trip_id_fkey";
            columns: ["trip_id"];
            isOneToOne: false;
            referencedRelation: "trips";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "trip_cities_city_id_fkey";
            columns: ["city_id"];
            isOneToOne: false;
            referencedRelation: "cities";
            referencedColumns: ["id"];
          },
        ];
      };
      photos: {
        Row: {
          id: string;
          user_id: string | null;
          country_id: string | null;
          city_id: string | null;
          trip_id: string | null;
          storage_path: string;
          caption: string | null;
          taken_at: string | null;
          sort_order: number;
          width: number | null;
          height: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Pick<
            Database["public"]["Tables"]["photos"]["Row"],
            | "id"
            | "user_id"
            | "country_id"
            | "city_id"
            | "trip_id"
            | "caption"
            | "taken_at"
            | "sort_order"
            | "width"
            | "height"
            | "created_at"
            | "updated_at"
          >
        > &
          Pick<Database["public"]["Tables"]["photos"]["Row"], "storage_path">;
        Update: Partial<Database["public"]["Tables"]["photos"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "photos_country_id_fkey";
            columns: ["country_id"];
            isOneToOne: false;
            referencedRelation: "countries";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "photos_city_id_fkey";
            columns: ["city_id"];
            isOneToOne: false;
            referencedRelation: "cities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "photos_trip_id_fkey";
            columns: ["trip_id"];
            isOneToOne: false;
            referencedRelation: "trips";
            referencedColumns: ["id"];
          },
        ];
      };
      country_ratings: {
        Row: {
          id: string;
          user_id: string | null;
          country_id: string;
          nature: number | null;
          food: number | null;
          transportation: number | null;
          safety: number | null;
          cleanliness: number | null;
          value_for_money: number | null;
          nightlife: number | null;
          friendliness: number | null;
          overall: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Pick<
            Database["public"]["Tables"]["country_ratings"]["Row"],
            | "id"
            | "user_id"
            | "nature"
            | "food"
            | "transportation"
            | "safety"
            | "cleanliness"
            | "value_for_money"
            | "nightlife"
            | "friendliness"
            | "created_at"
            | "updated_at"
          >
        > &
          Pick<Database["public"]["Tables"]["country_ratings"]["Row"], "country_id">;
        Update: Partial<Database["public"]["Tables"]["country_ratings"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "country_ratings_country_id_fkey";
            columns: ["country_id"];
            isOneToOne: true;
            referencedRelation: "countries";
            referencedColumns: ["id"];
          },
        ];
      };
      places: {
        Row: {
          id: string;
          user_id: string | null;
          country_id: string | null;
          city_id: string | null;
          kind: PlaceKind;
          name: string;
          address: string | null;
          latitude: number | null;
          longitude: number | null;
          notes: string | null;
          rating: number | null;
          source: PlaceSource;
          google_place_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Pick<
            Database["public"]["Tables"]["places"]["Row"],
            | "id"
            | "user_id"
            | "country_id"
            | "city_id"
            | "address"
            | "latitude"
            | "longitude"
            | "notes"
            | "rating"
            | "source"
            | "google_place_id"
            | "created_at"
            | "updated_at"
          >
        > &
          Pick<Database["public"]["Tables"]["places"]["Row"], "kind" | "name">;
        Update: Partial<Database["public"]["Tables"]["places"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "places_country_id_fkey";
            columns: ["country_id"];
            isOneToOne: false;
            referencedRelation: "countries";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "places_city_id_fkey";
            columns: ["city_id"];
            isOneToOne: false;
            referencedRelation: "cities";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_recommendations: {
        Row: {
          id: string;
          user_id: string | null;
          iso_a2: string;
          content: unknown;
          model: string;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Pick<
            Database["public"]["Tables"]["ai_recommendations"]["Row"],
            "id" | "user_id" | "created_at" | "updated_at"
          >
        > &
          Pick<Database["public"]["Tables"]["ai_recommendations"]["Row"], "iso_a2" | "content" | "model">;
        Update: Partial<Database["public"]["Tables"]["ai_recommendations"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];
export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"];
