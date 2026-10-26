const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  
  console.log("Renaming 'SuperAdmin' to 'SuperAdmin' in roles table...");
  
  const { error } = await supabase
    .from('roles')
    .update({ name: 'SuperAdmin' })
    .eq('name', 'SuperAdmin');
    
  if (error) {
    console.error("Error updating role:", error);
    process.exit(1);
  }
  
  console.log("Done.");
  process.exit(0);
}

main().catch(console.error);
