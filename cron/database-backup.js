import * as cron from "node-cron";


import {
  createBackupDb,
  deleteOldBackup,
} from "../controller/backupdatabase.controller.js";
import { deleteOldBinnacle } from "../controller/binnacle.controller.js";

export const  cronDatabaseBackup=async()=> {
    //ejectuar el cron cada 5 días a la 3:00 am hora del servidor
    cron.schedule("0 3 */5 * *", async () => {
        const result = await createBackupDb();

        if (!result) {
            console.log("Error al crear el backup");
        } else {
            console.log("Backup creado correctamente");
        }
    });
}

export const  deleteOldBackups=async()=> {
    //ejecutar cada 3 meses a la 1:00 am hora del servidor
    cron.schedule("0 1 1 */3 *", async () => {
      try {
        await deleteOldBackup();
        await deleteOldBinnacle();
      } catch (err) {
        console.log(err);
      }
    });
  }