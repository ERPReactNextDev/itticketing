import "./load-env";
import { connectDB } from "../src/lib/db/supabase";

async function main() {
  const supabase = await connectDB();
  
  console.log("Renaming 'SuperAdmin' to 'SuperAdmin' in roles table...");
  
  const { error } = await supabase
    .from("roles")
    .update({ name: "SuperAdmin" })
    .eq("name", "SuperAdmin");
    
  if (error) {
    console.error("Error updating role:", error);
    process.exit(1);
  }
  
  console.log("Done.");
  process.exit(0);
}

main().catch(console.error);
