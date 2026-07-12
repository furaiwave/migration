import { Module } from '@nestjs/common';
import { DbfModule } from './dbf/dbf.module';

@Module({
  imports: [DbfModule],
})
export class AppModule {}
